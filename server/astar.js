// A* on a 4-connected grid. grid[y][x]: 0 = free, 1 = obstacle.
export function astar(grid, start, goal) {
  const rows = grid.length, cols = grid[0].length;
  const key = (x, y) => y * cols + x;
  if (grid[goal.y]?.[goal.x] !== 0) return null;
  const h = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y);
  const open = [{ x: start.x, y: start.y, g: 0, f: h(start.x, start.y) }];
  const came = new Map();
  const gScore = new Map([[key(start.x, start.y), 0]]);
  const closed = new Set();

  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    closed.add(ck);

    if (cur.x === goal.x && cur.y === goal.y) {
      const path = [{ x: cur.x, y: cur.y }];
      let k = ck;
      while (came.has(k)) {
        const p = came.get(k);
        path.unshift(p);
        k = key(p.x, p.y);
      }
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || grid[ny][nx] !== 0) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = cur.g + 1;
      if (ng < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, ng);
        came.set(nk, { x: cur.x, y: cur.y });
        open.push({ x: nx, y: ny, g: ng, f: ng + h(nx, ny) });
      }
    }
  }
  return null;
}
