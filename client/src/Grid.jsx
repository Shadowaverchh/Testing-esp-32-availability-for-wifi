export default function Grid({ st, target, onCell }) {
  const { grid, pos, heading, route } = st;
  const onRoute = new Set(route.map((p) => `${p.x},${p.y}`));
  return (
    <div className="grid" style={{ '--cols': grid[0].length }}>
      {grid.map((row, y) =>
        row.map((v, x) => {
          const isBot = pos.x === x && pos.y === y;
          const isTarget = target && target.x === x && target.y === y;
          const cls = ['cell', v ? 'wall' : '', onRoute.has(`${x},${y}`) ? 'route' : '', isTarget ? 'target' : '']
            .filter(Boolean).join(' ');
          return (
            <button key={`${x},${y}`} className={cls} onClick={() => onCell(x, y)}
              aria-label={`Column ${x + 1}, row ${y + 1}${v ? ', blocked' : ''}${isBot ? ', robot' : ''}`}>
              {isBot && (
                <svg className="bot" viewBox="0 0 20 20" style={{ transform: `rotate(${heading * 90}deg)` }}>
                  <path d="M10 2 L17 17 L10 13 L3 17 Z" />
                </svg>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
