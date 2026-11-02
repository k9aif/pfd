// Small inline-SVG charts. No external libraries, so nothing leaves the machine.

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function progressRing(fraction, size = 64) {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  const svg = el('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img',
    'aria-label': `${Math.round(f * 100)}% of FIRE target` });
  svg.append(
    el('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--surface-2)', 'stroke-width': 8 }),
    el('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--sage)', 'stroke-width': 8,
      'stroke-linecap': 'round', 'stroke-dasharray': `${c * f} ${c}`,
      transform: `rotate(-90 ${size / 2} ${size / 2})` }),
  );
  return svg;
}

// rings: [{ radius, width, slices: [{ value, color, label }] }]
export function donut(rings, size = 190) {
  const svg = el('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img',
    'aria-label': 'Asset allocation, current vs target' });
  const cx = size / 2;
  for (const ring of rings) {
    const total = ring.slices.reduce((a, s) => a + Math.max(0, s.value), 0) || 1;
    const circ = 2 * Math.PI * ring.radius;
    let offset = 0;
    for (const s of ring.slices) {
      const len = (Math.max(0, s.value) / total) * circ;
      if (len <= 0) continue;
      const arc = el('circle', { cx, cy: cx, r: ring.radius, fill: 'none', stroke: s.color,
        'stroke-width': ring.width, 'stroke-dasharray': `${Math.max(0, len - 1.5)} ${circ}`,
        'stroke-dashoffset': -offset, transform: `rotate(-90 ${cx} ${cx})` });
      arc.append(el('title', {}, `${s.label}: ${Math.round((s.value / total) * 100)}%`));
      svg.append(arc);
      offset += len;
    }
  }
  return svg;
}

// series: [{ label, color, values: number[], dash? }], x labels from xStart.
export function lineChart({ series, xStart, target, formatY, width = 560, height = 260 }) {
  const pad = { l: 58, r: 14, t: 14, b: 28 };
  const n = Math.max(...series.map((s) => s.values.length));
  const maxY = Math.max(target ?? 0, ...series.flatMap((s) => s.values)) * 1.05 || 1;
  const x = (i) => pad.l + (i / Math.max(1, n - 1)) * (width - pad.l - pad.r);
  const y = (v) => height - pad.b - (v / maxY) * (height - pad.t - pad.b);
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img',
    'aria-label': 'Projected investable assets by age' });

  for (let k = 0; k <= 4; k++) {
    const v = (maxY / 4) * k;
    svg.append(el('line', { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), class: 'axis' }));
    svg.append(el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, formatY(v)));
  }
  const step = Math.max(1, Math.ceil(n / 9));
  for (let i = 0; i < n; i += step) {
    svg.append(el('text', { x: x(i), y: height - 8, 'text-anchor': 'middle' }, String(xStart + i)));
  }
  if (target) {
    svg.append(el('line', { x1: pad.l, x2: width - pad.r, y1: y(target), y2: y(target),
      stroke: 'var(--red)', 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }));
    svg.append(el('text', { x: width - pad.r, y: y(target) - 6, 'text-anchor': 'end' }, `FIRE target ${formatY(target)}`));
  }
  for (const s of series) {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    svg.append(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.5,
      'stroke-dasharray': s.dash ?? '', 'stroke-linejoin': 'round' }));
  }
  return svg;
}
