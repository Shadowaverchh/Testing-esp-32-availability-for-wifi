import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { WebSocketServer } from 'ws';
import { astar } from './astar.js';
import { CommandLog, RouteLog } from './models.js';

const PORT = process.env.PORT || 5000;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'change-me';
const COLS = 10, ROWS = 10;
const DRIVE_CMDS = ['F', 'B', 'L', 'R', 'S'];

// heading: 0 north (y-1), 1 east (x+1), 2 south (y+1), 3 west (x-1)
const state = {
  esp: { connected: false, rssi: null },
  pos: { x: 0, y: 0 },
  heading: 1,
  grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
  route: [],
  target: null,
  status: 'idle', // idle | moving | arrived | error
  message: '',
  config: { speed: 180, cellMs: 1200, turnMs: 550 },
  events: [],
};

// ---------- database (optional: server still works without it) ----------
mongoose
  .connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/robot', { serverSelectionTimeoutMS: 3000 })
  .then(() => console.log('MongoDB connected'))
  .catch(() => console.log('MongoDB not reachable, running without saved history'));
const dbReady = () => mongoose.connection.readyState === 1;

function logEvent(text) {
  state.events.unshift({ t: Date.now(), text });
  state.events.length = Math.min(state.events.length, 15);
}
function logCommand(cmd, source, detail) {
  if (dbReady()) CommandLog.create({ cmd, source, detail }).catch(() => {});
}

// ---------- sockets ----------
const uiClients = new Set();
let esp = null;
let nextId = 1;
const pending = new Map();

function broadcast() {
  const msg = JSON.stringify({ type: 'state', state });
  for (const c of uiClients) if (c.readyState === 1) c.send(msg);
}

function drive(cmd, ms) {
  return new Promise((resolve, reject) => {
    if (!esp) return reject(new Error('ESP32 is not connected'));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('ESP32 did not confirm the move'));
    }, (ms || 0) + 4000);
    pending.set(id, { resolve, reject, timer });
    esp.send(JSON.stringify({ id, cmd, ms, speed: state.config.speed }));
  });
}

function failPending(err) {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
}

function onEsp(ws) {
  if (esp) esp.close();
  esp = ws;
  state.esp.connected = true;
  logEvent('ESP32 connected');
  broadcast();

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'ack' && pending.has(m.id)) {
      const p = pending.get(m.id);
      clearTimeout(p.timer); pending.delete(m.id); p.resolve();
    } else if (m.type === 'status') {
      state.esp.rssi = m.rssi; broadcast();
    }
  });
  ws.on('close', () => {
    if (esp !== ws) return;
    esp = null;
    state.esp.connected = false;
    state.esp.rssi = null;
    runToken++;
    failPending(new Error('ESP32 disconnected'));
    if (state.status === 'moving') { state.status = 'error'; state.message = 'ESP32 disconnected'; state.route = []; }
    logEvent('ESP32 disconnected');
    broadcast();
  });
}

function onUi(ws) {
  uiClients.add(ws);
  ws.send(JSON.stringify({ type: 'state', state }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'drive' && DRIVE_CMDS.includes(m.cmd) && esp) {
      if (state.status === 'moving') { cancelRoute('Manual control took over'); broadcast(); }
      esp.send(JSON.stringify({ id: 0, cmd: m.cmd, speed: state.config.speed }));
      if (m.cmd === 'S') logCommand('S', 'manual');
    }
  });
  ws.on('close', () => uiClients.delete(ws));
}

// ---------- route runner ----------
let runToken = 0;

function cancelRoute(msg) {
  runToken++;
  failPending(new Error('Cancelled'));
  state.route = [];
  if (state.status === 'moving') { state.status = 'idle'; state.message = msg || ''; }
}

async function runRoute(route) {
  const token = ++runToken;
  state.route = route;
  state.status = 'moving';
  state.message = '';
  broadcast();
  try {
    for (let i = 1; i < route.length; i++) {
      const next = route[i];
      const dx = next.x - state.pos.x, dy = next.y - state.pos.y;
      const want = dx === 1 ? 1 : dx === -1 ? 3 : dy === 1 ? 2 : 0;
      const diff = (want - state.heading + 4) % 4;
      const turns = diff === 0 ? [] : diff === 1 ? ['R'] : diff === 3 ? ['L'] : ['R', 'R'];
      for (const t of turns) {
        if (token !== runToken) return;
        await drive(t, state.config.turnMs);
        state.heading = (state.heading + (t === 'R' ? 1 : 3)) % 4;
        broadcast();
      }
      if (token !== runToken) return;
      await drive('F', state.config.cellMs);
      state.pos = next;
      state.route = route.slice(i);
      broadcast();
    }
    if (token !== runToken) return;
    state.status = 'arrived';
    state.route = [];
    logEvent(`Arrived at (${state.pos.x}, ${state.pos.y})`);
    if (dbReady()) RouteLog.create({ from: route[0], to: route.at(-1), length: route.length - 1, result: 'arrived' }).catch(() => {});
  } catch (err) {
    if (token !== runToken) return;
    state.status = 'error';
    state.message = err.message;
    state.route = [];
    logEvent(`Route failed: ${err.message}`);
  }
  broadcast();
}

// ---------- REST ----------
const app = express();
app.use(cors());
app.use(express.json());

const inGrid = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < COLS && y < ROWS;

app.get('/api/state', (_req, res) => res.json(state));

app.post('/api/goto', (req, res) => {
  const { x, y } = req.body;
  if (!inGrid(x, y)) return res.status(400).json({ error: 'That cell is outside the map' });
  if (!state.esp.connected) return res.status(409).json({ error: 'ESP32 is not connected' });
  if (state.grid[y][x] === 1) return res.status(400).json({ error: 'That cell is blocked' });
  const route = astar(state.grid, state.pos, { x, y });
  if (!route) return res.status(404).json({ error: 'No route to that cell' });
  state.target = { x, y };
  logEvent(`Going to (${x}, ${y}), ${route.length - 1} steps`);
  logCommand('goto', 'web', { x, y });
  if (route.length === 1) { state.status = 'arrived'; broadcast(); return res.json({ route }); }
  runRoute(route);
  res.json({ route });
});

app.post('/api/stop', (_req, res) => {
  cancelRoute('Stopped');
  if (esp) esp.send(JSON.stringify({ id: 0, cmd: 'S' }));
  logEvent('Stopped');
  logCommand('stop', 'web');
  broadcast();
  res.json({ ok: true });
});

app.post('/api/cell', (req, res) => {
  const { x, y } = req.body;
  if (!inGrid(x, y)) return res.status(400).json({ error: 'That cell is outside the map' });
  if (x === state.pos.x && y === state.pos.y) return res.status(400).json({ error: 'The robot is on that cell' });
  if (state.status === 'moving') return res.status(409).json({ error: 'Stop the robot before editing the map' });
  state.grid[y][x] = state.grid[y][x] ? 0 : 1;
  if (state.target && state.target.x === x && state.target.y === y) state.target = null;
  broadcast();
  res.json({ ok: true });
});

app.post('/api/position', (req, res) => {
  const { x, y, heading } = req.body;
  if (!inGrid(x, y) || ![0, 1, 2, 3].includes(heading)) return res.status(400).json({ error: 'Invalid position' });
  if (state.status === 'moving') return res.status(409).json({ error: 'Stop the robot first' });
  state.pos = { x, y };
  state.heading = heading;
  state.grid[y][x] = 0;
  state.status = 'idle';
  broadcast();
  res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
  const { speed, cellMs, turnMs } = req.body;
  const c = state.config;
  if (speed !== undefined) c.speed = Math.min(255, Math.max(60, Number(speed) || c.speed));
  if (cellMs !== undefined) c.cellMs = Math.min(10000, Math.max(100, Number(cellMs) || c.cellMs));
  if (turnMs !== undefined) c.turnMs = Math.min(5000, Math.max(50, Number(turnMs) || c.turnMs));
  broadcast();
  res.json(c);
});

app.get('/api/history', async (_req, res) => {
  if (!dbReady()) return res.json({ commands: [], routes: [] });
  const [commands, routes] = await Promise.all([
    CommandLog.find().sort({ createdAt: -1 }).limit(50).lean(),
    RouteLog.find().sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  res.json({ commands, routes });
});

// serve the built React app (npm run build in /client)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, '../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------- start ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/esp') {
    if (url.searchParams.get('token') !== DEVICE_TOKEN) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, onEsp);
  } else if (url.pathname === '/ui') {
    wss.handleUpgrade(req, socket, head, onUi);
  } else socket.destroy();
});
server.listen(PORT, '0.0.0.0', () => console.log(`Server on http://0.0.0.0:${PORT}`));
