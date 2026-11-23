import { useCallback, useEffect, useRef, useState } from 'react';
import Grid from './Grid.jsx';

async function api(path, body) {
  const r = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

function useRobot() {
  const [st, setSt] = useState(null);
  const [link, setLink] = useState(false);
  const ws = useRef(null);

  useEffect(() => {
    let closed = false, timer;
    const connect = () => {
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ui`);
      ws.current = s;
      s.onopen = () => setLink(true);
      s.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'state') setSt(m.state);
      };
      s.onclose = () => {
        setLink(false);
        if (!closed) timer = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws.current?.close(); };
  }, []);

  const send = useCallback((msg) => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(msg));
  }, []);
  return { st, link, send };
}

const KEYS = { w: 'F', arrowup: 'F', s: 'B', arrowdown: 'B', a: 'L', arrowleft: 'L', d: 'R', arrowright: 'R' };

function DrivePad({ send, disabled }) {
  const timer = useRef(null);
  const active = useRef(null);

  const stop = useCallback(() => {
    clearInterval(timer.current);
    if (active.current) send({ type: 'drive', cmd: 'S' });
    active.current = null;
  }, [send]);

  const start = useCallback((cmd) => {
    if (disabled) return;
    clearInterval(timer.current);
    active.current = cmd;
    send({ type: 'drive', cmd });
    // the ESP32 stops on its own if these repeats stop arriving
    timer.current = setInterval(() => send({ type: 'drive', cmd }), 200);
  }, [send, disabled]);

  useEffect(() => {
    const down = (e) => {
      if (e.repeat || e.target.tagName === 'INPUT') return;
      const cmd = KEYS[e.key.toLowerCase()];
      if (cmd) { e.preventDefault(); start(cmd); }
      if (e.key === ' ') { e.preventDefault(); stop(); send({ type: 'drive', cmd: 'S' }); }
    };
    const up = (e) => {
      const cmd = KEYS[e.key.toLowerCase()];
      if (cmd && active.current === cmd) stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); stop(); };
  }, [start, stop, send]);

  const hold = (cmd, label) => (
    <button className="pad" disabled={disabled} aria-label={label}
      onPointerDown={() => start(cmd)} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}>
      {label}
    </button>
  );

  return (
    <div className="padgrid">
      <span />{hold('F', 'Forward')}<span />
      {hold('L', 'Left')}
      <button className="pad halt" disabled={disabled} onClick={() => { stop(); send({ type: 'drive', cmd: 'S' }); }}>Stop</button>
      {hold('R', 'Right')}
      <span />{hold('B', 'Back')}<span />
    </div>
  );
}

function Num({ label, value, min, max, step, onSave }) {
  return (
    <label className="num">
      <span>{label}</span>
      <input key={value} type="number" defaultValue={value} min={min} max={max} step={step}
        onBlur={(e) => onSave(Number(e.target.value))}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </label>
  );
}

const compass = ['north', 'east', 'south', 'west'];

export default function App() {
  const { st, link, send } = useRobot();
  const [target, setTarget] = useState(null);
  const [mode, setMode] = useState('destination');
  const [err, setErr] = useState('');

  const run = (p) => p.then(() => setErr('')).catch((e) => setErr(e.message));

  if (!st) return <p className="wait">{link ? 'Loading…' : 'Connecting to the server…'}</p>;

  const online = st.esp.connected;
  const moving = st.status === 'moving';
  const statusText =
    moving ? `Driving to (${st.target?.x}, ${st.target?.y})`
    : st.status === 'arrived' ? 'Arrived'
    : st.status === 'error' ? `Stopped: ${st.message}`
    : st.message || 'Waiting for a destination';

  const saveCfg = (k) => (v) => run(api('/config', { [k]: v }));

  return (
    <>
      <header className="top">
        <h1>Robot control</h1>
        <div className="conn">
          <span className={'dot' + (online ? ' on' : '')} />
          {online ? `Robot online${st.esp.rssi ? ` · Wi-Fi ${st.esp.rssi} dBm` : ''}` : link ? 'Robot offline' : 'Server unreachable'}
        </div>
      </header>

      <main>
        <section>
          <div className="modes" role="group" aria-label="Map tool">
            <button className={mode === 'destination' ? 'on' : ''} onClick={() => setMode('destination')}>Pick destination</button>
            <button className={mode === 'obstacles' ? 'on' : ''} onClick={() => setMode('obstacles')}>Mark obstacles</button>
          </div>
          <Grid st={st} target={target}
            onCell={(x, y) => (mode === 'obstacles' ? run(api('/cell', { x, y })) : setTarget({ x, y }))} />
          <p className="hint">
            Robot at ({st.pos.x}, {st.pos.y}) facing {compass[st.heading]}.
            {mode === 'destination' ? ' Click a cell, then press Go.' : ' Click a cell to block or clear it.'}
          </p>
        </section>

        <aside>
          <div className="block">
            <p className={'status ' + st.status}>{statusText}</p>
            <div className="row">
              <button className="primary" disabled={!target || !online || moving} onClick={() => run(api('/goto', target))}>
                {target ? `Go to (${target.x}, ${target.y})` : 'Go'}
              </button>
              <button className="danger" onClick={() => run(api('/stop'))}>Stop</button>
            </div>
            {err && <p className="err">{err}</p>}
          </div>

          <div className="block">
            <h2>Manual drive</h2>
            <DrivePad send={send} disabled={!online} />
            <p className="hint">Hold a button or use W A S D. Release to stop.</p>
          </div>

          <div className="block">
            <h2>Calibration</h2>
            <Num label="Motor speed (60–255)" value={st.config.speed} min={60} max={255} onSave={saveCfg('speed')} />
            <Num label="Time per cell (ms)" value={st.config.cellMs} min={100} max={10000} step={50} onSave={saveCfg('cellMs')} />
            <Num label="Time per 90° turn (ms)" value={st.config.turnMs} min={50} max={5000} step={25} onSave={saveCfg('turnMs')} />
            <div className="row">
              <button disabled={moving} onClick={() => run(api('/position', { x: 0, y: 0, heading: 1 }))}>Reset position to (0, 0)</button>
            </div>
          </div>

          <div className="block">
            <h2>Activity</h2>
            {st.events.length === 0 ? <p className="hint">Nothing yet.</p> : (
              <ul className="events">
                {st.events.map((e) => (
                  <li key={e.t + e.text}><time>{new Date(e.t).toLocaleTimeString()}</time> {e.text}</li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </main>
    </>
  );
}
