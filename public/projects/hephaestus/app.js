'use strict';

/**
 * Hephaestus — rare-earth element index family.
 *
 * Three fixed-basket (Laspeyres) price indices over the seventeen rare earths,
 * rebased to 100 at Jan-2010. One estimator, three quantity vectors:
 *
 *   I_b(t) = 100 * Σ q_i^(b)·p_i(t) / Σ q_i^(b)·p_i(t0)
 *
 * Prices p_i(t) are monthly, log-linearly interpolated between dated public
 * anchor prints (see ELEMENTS[].a). No live feed, no fabricated volatility —
 * the specification is the whole point. Self-contained: no charting library.
 */

// ---------------------------------------------------------------------------
// 1. Constituent data
//
//   cons  global annual consumption, tonnes REO (structural — the QG-VAL basket)
//   S     supply concentration, 0–1 — refined-output share of the single dominant
//         jurisdiction (an HHI proxy; heavies from S.China/Myanmar ionic clay ~0.95)
//   E     economic criticality, 0–1 — end-use value × substitutability × strategic use
//   mag   permanent-magnet-sector consumption, tonnes (the QG-MAG basket; 0 if none)
//   a     price anchors [ 'YYYY-MM', $/kg oxide FOB China ], log-linearly interpolated
//   q     price-data quality: reported | thin | modeled | none
// ---------------------------------------------------------------------------

const ANCHORS_T0 = '2010-01';
const ANCHORS_TN = '2026-06';

const ELEMENTS = [
  { z: 57, sym: 'La', name: 'Lanthanum',    heavy: false, cons: 45000, S: 0.82, E: 0.50, mag: 0, q: 'reported',
    a: [['2010-01',8],['2011-07',140],['2012-06',25],['2013-06',12],['2015-06',2.5],['2017-06',2.0],['2019-06',1.8],['2020-06',1.5],['2021-06',1.2],['2022-01',1.3],['2022-09',1.0],['2023-06',0.9],['2024-06',0.7],['2025-06',0.7],['2026-06',0.8]] },
  { z: 58, sym: 'Ce', name: 'Cerium',       heavy: false, cons: 55000, S: 0.82, E: 0.45, mag: 0, q: 'reported',
    a: [['2010-01',8],['2011-07',150],['2012-06',25],['2013-06',10],['2015-06',2.5],['2017-06',1.8],['2019-06',1.7],['2020-06',1.4],['2021-06',1.1],['2022-01',1.2],['2022-09',1.0],['2023-06',0.85],['2024-06',0.7],['2025-06',0.7],['2026-06',0.8]] },
  { z: 59, sym: 'Pr', name: 'Praseodymium', heavy: false, cons: 9000,  S: 0.85, E: 0.95, mag: 7000, q: 'reported',
    a: [['2010-01',35],['2011-07',250],['2012-06',130],['2013-06',110],['2015-06',70],['2017-06',60],['2019-06',55],['2020-06',50],['2021-06',110],['2022-01',160],['2022-09',120],['2023-06',80],['2024-06',60],['2025-06',68],['2026-06',74]] },
  { z: 60, sym: 'Nd', name: 'Neodymium',    heavy: false, cons: 32000, S: 0.85, E: 1.00, mag: 25000, q: 'reported',
    a: [['2010-01',40],['2011-07',338],['2012-06',110],['2013-06',75],['2015-06',45],['2017-06',50],['2019-06',48],['2020-06',52],['2021-06',140],['2022-01',185],['2022-09',130],['2023-06',80],['2024-06',58],['2025-06',66],['2026-06',72]] },
  { z: 61, sym: 'Pm', name: 'Promethium',   heavy: false, cons: 0,     S: 1.00, E: 0.00, mag: 0, q: 'none', a: null },
  { z: 62, sym: 'Sm', name: 'Samarium',     heavy: false, cons: 3000,  S: 0.90, E: 0.60, mag: 0, q: 'reported',
    a: [['2010-01',34],['2011-07',140],['2012-06',80],['2013-06',40],['2015-06',5],['2017-06',2.0],['2019-06',1.8],['2020-06',1.7],['2021-06',2.5],['2022-01',3.0],['2022-09',2.2],['2023-06',1.8],['2024-06',1.6],['2025-06',2.2],['2026-06',2.6]] },
  { z: 63, sym: 'Eu', name: 'Europium',     heavy: true,  cons: 300,   S: 0.95, E: 0.30, mag: 0, q: 'reported',
    a: [['2010-01',550],['2011-07',3800],['2012-06',2600],['2013-06',1200],['2015-06',150],['2017-06',80],['2019-06',40],['2020-06',32],['2021-06',30],['2022-01',32],['2022-09',30],['2023-06',28],['2024-06',26],['2025-06',28],['2026-06',30]] },
  { z: 64, sym: 'Gd', name: 'Gadolinium',   heavy: true,  cons: 3000,  S: 0.92, E: 0.45, mag: 0, q: 'reported',
    a: [['2010-01',15],['2011-07',150],['2012-06',70],['2013-06',45],['2015-06',35],['2017-06',30],['2019-06',28],['2020-06',25],['2021-06',40],['2022-01',55],['2022-09',45],['2023-06',38],['2024-06',33],['2025-06',37],['2026-06',42]] },
  { z: 65, sym: 'Tb', name: 'Terbium',      heavy: true,  cons: 400,   S: 0.96, E: 0.92, mag: 300, q: 'reported',
    a: [['2010-01',600],['2011-07',3800],['2012-06',2200],['2013-06',1000],['2015-06',500],['2017-06',450],['2019-06',520],['2020-06',600],['2021-06',1400],['2022-01',2300],['2022-09',1600],['2023-06',1050],['2024-06',800],['2025-06',920],['2026-06',1050]] },
  { z: 66, sym: 'Dy', name: 'Dysprosium',   heavy: true,  cons: 1800,  S: 0.95, E: 0.95, mag: 1400, q: 'reported',
    a: [['2010-01',150],['2011-07',2840],['2012-06',1200],['2013-06',600],['2015-06',240],['2017-06',190],['2019-06',270],['2020-06',250],['2021-06',400],['2022-01',450],['2022-09',360],['2023-06',290],['2024-06',230],['2025-06',255],['2026-06',295]] },
  { z: 67, sym: 'Ho', name: 'Holmium',      heavy: true,  cons: 200,   S: 0.95, E: 0.30, mag: 0, q: 'thin',
    a: [['2010-01',40],['2011-07',1500],['2012-06',600],['2013-06',120],['2015-06',60],['2017-06',55],['2019-06',60],['2020-06',58],['2021-06',90],['2022-01',120],['2022-09',100],['2023-06',85],['2024-06',75],['2025-06',85],['2026-06',95]] },
  { z: 68, sym: 'Er', name: 'Erbium',       heavy: true,  cons: 1200,  S: 0.93, E: 0.35, mag: 0, q: 'thin',
    a: [['2010-01',40],['2011-07',1000],['2012-06',180],['2013-06',80],['2015-06',45],['2017-06',30],['2019-06',28],['2020-06',26],['2021-06',35],['2022-01',45],['2022-09',38],['2023-06',32],['2024-06',28],['2025-06',31],['2026-06',35]] },
  { z: 69, sym: 'Tm', name: 'Thulium',      heavy: true,  cons: 50,    S: 0.95, E: 0.25, mag: 0, q: 'modeled',
    a: [['2010-01',400],['2011-07',2000],['2012-06',1000],['2013-06',600],['2015-06',500],['2017-06',480],['2019-06',520],['2020-06',540],['2021-06',600],['2022-01',700],['2022-09',650],['2023-06',600],['2024-06',580],['2025-06',620],['2026-06',680]] },
  { z: 70, sym: 'Yb', name: 'Ytterbium',    heavy: true,  cons: 300,   S: 0.93, E: 0.30, mag: 0, q: 'thin',
    a: [['2010-01',35],['2011-07',1000],['2012-06',300],['2013-06',60],['2015-06',30],['2017-06',22],['2019-06',20],['2020-06',18],['2021-06',25],['2022-01',32],['2022-09',28],['2023-06',24],['2024-06',20],['2025-06',23],['2026-06',27]] },
  { z: 71, sym: 'Lu', name: 'Lutetium',     heavy: true,  cons: 60,    S: 0.90, E: 0.40, mag: 0, q: 'thin',
    a: [['2010-01',600],['2011-07',2000],['2012-06',1200],['2013-06',900],['2015-06',700],['2017-06',650],['2019-06',620],['2020-06',600],['2021-06',700],['2022-01',800],['2022-09',750],['2023-06',700],['2024-06',680],['2025-06',720],['2026-06',780]] },
  { z: 21, sym: 'Sc', name: 'Scandium',     heavy: false, cons: 30,    S: 0.80, E: 0.60, mag: 0, q: 'modeled',
    a: [['2010-01',1500],['2011-07',2500],['2012-06',2000],['2013-06',1800],['2015-06',1600],['2017-06',1400],['2019-06',1300],['2020-06',1250],['2021-06',1300],['2022-01',1400],['2022-09',1350],['2023-06',1300],['2024-06',1250],['2025-06',1300],['2026-06',1400]] },
  { z: 39, sym: 'Y',  name: 'Yttrium',      heavy: true,  cons: 8000,  S: 0.95, E: 0.40, mag: 0, q: 'reported',
    a: [['2010-01',15],['2011-07',170],['2012-06',110],['2013-06',40],['2015-06',8],['2017-06',5],['2019-06',4],['2020-06',4.5],['2021-06',8],['2022-01',12],['2022-09',9],['2023-06',7],['2024-06',6],['2025-06',7],['2026-06',8]] },
];

const INDEX_DEFS = [
  { k: 'scx', code: 'QG-SCX', q: (e) => e.cons * e.S * e.E },
  { k: 'mag', code: 'QG-MAG', q: (e) => e.mag },
  { k: 'val', code: 'QG-VAL', q: (e) => e.cons },
];

// ---------------------------------------------------------------------------
// 2. Build the monthly grid and interpolate each element's price series
// ---------------------------------------------------------------------------

const MONTHNAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const mi = (s) => { const [y, m] = s.split('-').map(Number); return (y - 2000) * 12 + (m - 1); };
const monthLabel = (idx) => `${MONTHNAMES[idx % 12]} ${2000 + Math.floor(idx / 12)}`;
const monthShort = (idx) => `${MONTHNAMES[idx % 12]} '${String(2000 + Math.floor(idx / 12)).slice(2)}`;

const T0 = mi(ANCHORS_T0);
const TN = mi(ANCHORS_TN);
const MONTHS = [];
for (let t = T0; t <= TN; t++) MONTHS.push(t);
const N = MONTHS.length;

// Log-linear interpolation between anchors; flat before first / after last.
function interpolate(anchors) {
  const pts = anchors.map(([m, p]) => [mi(m), p]);
  const out = new Array(N);
  for (let j = 0; j < N; j++) {
    const t = MONTHS[j];
    if (t <= pts[0][0]) { out[j] = pts[0][1]; continue; }
    if (t >= pts[pts.length - 1][0]) { out[j] = pts[pts.length - 1][1]; continue; }
    let k = 0;
    while (k < pts.length - 1 && pts[k + 1][0] < t) k++;
    const [t1, p1] = pts[k];
    const [t2, p2] = pts[k + 1];
    const f = (t - t1) / (t2 - t1);
    out[j] = Math.exp(Math.log(p1) + f * (Math.log(p2) - Math.log(p1))); // geometric
  }
  return out;
}

for (const e of ELEMENTS) e.series = e.a ? interpolate(e.a) : null;

// ---------------------------------------------------------------------------
// 3. Compute the three index series + base-date weights
// ---------------------------------------------------------------------------

const priced = ELEMENTS.filter((e) => e.series);

const INDICES = {};        // k -> [levels] length N
const WEIGHTS = {};        // k -> { sym: shareAtT0 }
for (const def of INDEX_DEFS) {
  const qv = priced.map((e) => ({ e, q: def.q(e) }));
  const denom = qv.reduce((s, { e, q }) => s + q * e.series[0], 0);
  const levels = new Array(N);
  for (let j = 0; j < N; j++) {
    let num = 0;
    for (const { e, q } of qv) num += q * e.series[j];
    levels[j] = 100 * num / denom;
  }
  INDICES[def.k] = levels;
  const w = {};
  for (const { e, q } of qv) w[e.sym] = (q * e.series[0]) / denom;
  WEIGHTS[def.k] = w;
}

// ---------------------------------------------------------------------------
// 4. State
// ---------------------------------------------------------------------------

const SERIES = [
  { k: 'scx', code: 'QG-SCX' },
  { k: 'mag', code: 'QG-MAG' },
  { k: 'val', code: 'QG-VAL' },
];
const state = {
  visible: { scx: true, mag: true, val: true },
  range: 'all',     // months from end, or 'all'
  scale: 'log',
  hover: null,      // month index j, or null
};

// Plot geometry (viewBox units)
const VB = { w: 1000, h: 440 };
const M = { top: 18, right: 56, bottom: 26, left: 8 };
const PW = VB.w - M.left - M.right;
const PH = VB.h - M.top - M.bottom;

function visibleRange() {
  if (state.range === 'all') return [0, N - 1];
  const n = parseInt(state.range, 10);
  return [Math.max(0, N - 1 - n), N - 1];
}

// ---------------------------------------------------------------------------
// 5. Rendering
// ---------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('chart');
const fmt = (v, d = 1) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = (v) => Math.round(v).toLocaleString('en-US');
const fmtPrice = (v) => v >= 100 ? fmtInt(v) : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
const el = (tag, attrs, text) => {
  const n = document.createElementNS(NS, tag);
  for (const key in attrs) n.setAttribute(key, attrs[key]);
  if (text != null) n.textContent = text;
  return n;
};

function niceLinTicks(lo, hi, target = 5) {
  const span = hi - lo || 1;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
  return ticks;
}
function niceLogTicks(lo, hi) {
  const ticks = [];
  const d0 = Math.floor(Math.log10(lo));
  const d1 = Math.ceil(Math.log10(hi));
  for (let d = d0; d <= d1; d++) {
    for (const mlt of [1, 2, 5]) {
      const v = mlt * Math.pow(10, d);
      if (v >= lo * 0.999 && v <= hi * 1.001) ticks.push(v);
    }
  }
  return ticks.length >= 3 ? ticks : niceLinTicks(lo, hi);
}

function render() {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const [a, b] = visibleRange();
  const span = b - a;

  // y-domain over visible window across visible series (fallback: all series)
  const activeKeys = SERIES.filter((s) => state.visible[s.k]).map((s) => s.k);
  const keys = activeKeys.length ? activeKeys : SERIES.map((s) => s.k);
  let lo = Infinity, hi = -Infinity;
  for (const k of keys) for (let j = a; j <= b; j++) { const v = INDICES[k][j]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const log = state.scale === 'log';
  if (log) { lo = Math.max(lo * 0.9, 1); hi = hi * 1.08; }
  else { const pad = (hi - lo) * 0.08 || 1; lo = Math.max(0, lo - pad); hi = hi + pad; }

  const X = (j) => M.left + (span === 0 ? 0.5 : (j - a) / span) * PW;
  const yScale = log
    ? (v) => { const t = (Math.log(Math.max(v, 1e-6)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)); return M.top + (1 - t) * PH; }
    : (v) => { const t = (v - lo) / (hi - lo); return M.top + (1 - t) * PH; };

  // --- gridlines + y ticks (right axis, TradingView-style) ---
  const yticks = log ? niceLogTicks(lo, hi) : niceLinTicks(lo, hi);
  for (const v of yticks) {
    const y = yScale(v);
    if (y < M.top - 1 || y > M.top + PH + 1) continue;
    svg.appendChild(el('line', { class: 'grid-line', x1: M.left, y1: y.toFixed(1), x2: M.left + PW, y2: y.toFixed(1) }));
    svg.appendChild(el('text', { class: 'ytick', x: M.left + PW + 8, y: (y + 3.2).toFixed(1), 'text-anchor': 'start' }, fmtInt(v)));
  }

  // --- x ticks (year boundaries) ---
  let lastYear = null;
  for (let j = a; j <= b; j++) {
    const t = MONTHS[j];
    const year = 2000 + Math.floor(t / 12);
    const isJan = t % 12 === 0;
    const yearStep = span > 150 ? 2 : 1;
    if (isJan && year !== lastYear && year % yearStep === 0) {
      lastYear = year;
      const x = X(j);
      svg.appendChild(el('line', { class: 'grid-line', x1: x.toFixed(1), y1: M.top, x2: x.toFixed(1), y2: M.top + PH }));
      svg.appendChild(el('text', { x: x.toFixed(1), y: VB.h - 8, 'text-anchor': 'middle' }, `'${String(year).slice(2)}`));
    }
  }
  svg.appendChild(el('line', { class: 'axis-base', x1: M.left, y1: M.top + PH, x2: M.left + PW, y2: M.top + PH }));

  // --- series (draw hidden first so visible sit on top; VAL, MAG, SCX order) ---
  const ends = [];
  for (const s of [...SERIES].reverse()) {
    if (!state.visible[s.k]) continue;
    const lv = INDICES[s.k];
    let line = '', area = '';
    for (let j = a; j <= b; j++) {
      const x = X(j).toFixed(1), y = yScale(lv[j]).toFixed(1);
      line += `${j === a ? 'M' : 'L'}${x},${y}`;
    }
    area = `M${X(a).toFixed(1)},${(M.top + PH).toFixed(1)}` +
      line.replace(/^M/, 'L') + `L${X(b).toFixed(1)},${(M.top + PH).toFixed(1)}Z`;
    const grad = `grad-${s.k}`;
    svg.appendChild(el('path', { d: area, fill: `url(#${grad})`, class: 'serie-area' }));
    svg.appendChild(el('path', { d: line, class: `serie-line ${s.k}` }));
    ends.push({ k: s.k, code: s.code, y: yScale(lv[b]) });
  }
  // end labels — declutter so overlapping series don't stack illegibly
  ends.sort((p, q) => p.y - q.y);
  const GAP = 13;
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < GAP) ends[i].y = ends[i - 1].y + GAP;
  for (const en of ends) {
    const yy = Math.max(M.top + 8, Math.min(M.top + PH - 2, en.y));
    svg.appendChild(el('text', { class: `end-label ${en.k}`, x: (M.left + PW + 8).toFixed(1), y: yy.toFixed(1), 'text-anchor': 'start' }, en.code));
  }

  // gradient defs
  const defs = el('defs', {});
  for (const s of SERIES) {
    const lg = el('linearGradient', { id: `grad-${s.k}`, x1: '0', y1: '0', x2: '0', y2: '1' });
    lg.appendChild(el('stop', { offset: '0%', 'stop-color': `var(--${s.k})`, 'stop-opacity': '0.16' }));
    lg.appendChild(el('stop', { offset: '100%', 'stop-color': `var(--${s.k})`, 'stop-opacity': '0' }));
    defs.appendChild(lg);
  }
  svg.appendChild(defs);

  // --- crosshair + dots ---
  const jh = state.hover != null && state.hover >= a && state.hover <= b ? state.hover : null;
  if (jh != null) {
    const x = X(jh);
    svg.appendChild(el('line', { class: 'crosshair-v', x1: x.toFixed(1), y1: M.top, x2: x.toFixed(1), y2: M.top + PH }));
    for (const s of SERIES) {
      if (!state.visible[s.k]) continue;
      svg.appendChild(el('circle', { class: `dot ${s.k}`, cx: x.toFixed(1), cy: yScale(INDICES[s.k][jh]).toFixed(1), r: 3.4 }));
    }
  }

  svg._geom = { a, b, X };
  updateReadout(jh != null ? jh : b, a);
  updateTicker(a, b);
}

// Readout in the toolbar (scrub target)
function updateReadout(j, a) {
  const rd = document.getElementById('r-date');
  rd.textContent = monthLabel(MONTHS[j]);
  const box = document.getElementById('readout');
  // clear existing r-items
  box.querySelectorAll('.r-item').forEach((n) => n.remove());
  for (const s of SERIES) {
    if (!state.visible[s.k]) continue;
    const v = INDICES[s.k][j];
    const item = document.createElement('span');
    item.className = 'r-item';
    const lab = document.createElement('span');
    lab.className = 'rl'; lab.textContent = s.code + ' ';
    const val = document.createElement('b');
    val.style.color = `var(--${s.k})`;
    val.textContent = fmt(v, 1);
    item.appendChild(lab); item.appendChild(val);
    box.appendChild(item);
  }
}

function pctStr(p) { return (p >= 0 ? '+' : '') + fmt(p, 1) + '%'; }

function updateTicker(a, b) {
  for (const s of SERIES) {
    const lv = INDICES[s.k];
    const now = lv[b], base = lv[a];
    document.getElementById('lvl-' + s.k).textContent = fmt(now, 1);
    const chg = document.getElementById('chg-' + s.k);
    const p = (now / base - 1) * 100;
    chg.className = 'chg ' + (p >= 0 ? 'up' : 'dn');
    const rangeLabel = state.range === 'all' ? "since '10" : `${monthShort(MONTHS[a])}`;
    chg.innerHTML = '';
    const strong = document.createElement('span');
    strong.textContent = pctStr(p) + ' ';
    const rng = document.createElement('span');
    rng.className = 'rng';
    rng.textContent = state.range === 'all' ? "since '10" : `vs ${rangeLabel}`;
    chg.appendChild(strong); chg.appendChild(rng);
  }
  document.querySelectorAll('#ticker .tk').forEach((t) => {
    t.classList.toggle('off', !state.visible[t.getAttribute('data-k')]);
  });
}

// ---------------------------------------------------------------------------
// 6. Interactions
// ---------------------------------------------------------------------------

function pointerToMonth(clientX) {
  const g = svg._geom;
  if (!g) return null;
  const rect = svg.getBoundingClientRect();
  const px = ((clientX - rect.left) / rect.width) * VB.w;
  const { a, b } = g;
  const span = b - a || 1;
  const f = (px - M.left) / PW;
  let j = Math.round(a + f * span);
  return Math.max(a, Math.min(b, j));
}
function onMove(e) {
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const j = pointerToMonth(cx);
  if (j !== state.hover) { state.hover = j; render(); }
}
function onLeave() { if (state.hover != null) { state.hover = null; render(); } }

svg.addEventListener('pointermove', onMove);
svg.addEventListener('pointerleave', onLeave);
svg.addEventListener('touchmove', onMove, { passive: true });
svg.addEventListener('touchend', onLeave);

document.getElementById('range-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  state.range = btn.getAttribute('data-range');
  document.querySelectorAll('#range-seg button').forEach((x) => x.classList.toggle('active', x === btn));
  render();
});
document.getElementById('scale-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  state.scale = btn.getAttribute('data-scale');
  document.querySelectorAll('#scale-seg button').forEach((x) => x.classList.toggle('active', x === btn));
  document.querySelector('.chart-foot span:last-child').innerHTML =
    `Monthly &middot; oxide baskets, FOB China &middot; ${state.scale === 'log' ? 'log' : 'linear'} scale`;
  render();
});
document.getElementById('ticker').addEventListener('click', (e) => {
  const tk = e.target.closest('.tk'); if (!tk) return;
  const k = tk.getAttribute('data-k');
  const on = Object.values(state.visible).filter(Boolean).length;
  if (state.visible[k] && on === 1) return;   // keep at least one visible
  state.visible[k] = !state.visible[k];
  render();
});

// ---------------------------------------------------------------------------
// 7. Constituents table + as-of stamps
// ---------------------------------------------------------------------------

function wbar(share) {
  const pct = (share * 100);
  const width = Math.max(share > 0 ? 2 : 0, share * 120); // px within 150px cell
  return { pct, width };
}

function buildTable() {
  const body = document.getElementById('const-body');
  const rows = [...ELEMENTS].sort((x, y) => {
    // order by combined prominence: value weight desc, Pm last
    if (!x.series) return 1; if (!y.series) return -1;
    return (WEIGHTS.val[y.sym] || 0) - (WEIGHTS.val[x.sym] || 0);
  });
  for (const e of rows) {
    const tr = document.createElement('tr');
    const now = e.series ? e.series[N - 1] : null;
    const since = e.series ? (e.series[N - 1] / e.series[0] - 1) * 100 : null;
    const cell = (html, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.innerHTML = html; return td; };

    tr.appendChild(cell(String(e.z), 'l muted'));
    tr.appendChild(cell(`<span class="el-sym${e.heavy ? ' heavy' : ''}">${e.sym}</span><span class="el-name">${e.name}</span>`, 'l'));
    tr.appendChild(cell(e.q === 'none' ? '—' : (e.heavy ? 'Heavy' : 'Light'), 'l muted'));

    if (!e.series) {
      tr.appendChild(cell('n/a', 'muted'));
      tr.appendChild(cell('—', 'muted'));
      tr.appendChild(cell('<span class="muted" style="font-size:11px">excluded</span>', 'l'));
      tr.appendChild(cell('<span class="muted" style="font-size:11px">excluded</span>', 'l'));
      tr.appendChild(cell('<span class="muted" style="font-size:11px">excluded</span>', 'l'));
      tr.appendChild(cell('<span class="qflag none">No market</span>', 'l'));
      body.appendChild(tr);
      continue;
    }

    tr.appendChild(cell('$' + fmtPrice(now)));
    const sc = since >= 0 ? '#6fbf8f' : '#c58585';
    tr.appendChild(cell(`<span style="color:${sc}">${(since >= 0 ? '+' : '') + fmtInt(since)}%</span>`));

    for (const k of ['scx', 'mag', 'val']) {
      const share = WEIGHTS[k][e.sym] || 0;
      const { pct, width } = wbar(share);
      const txt = share > 0 ? (pct >= 10 ? pct.toFixed(0) : pct >= 1 ? pct.toFixed(1) : pct.toFixed(2)) + '%' : '—';
      const html = `<span style="display:inline-block;width:44px;text-align:right;color:${share > 0 ? '#cbcbc6' : 'var(--faint)'}">${txt}</span>` +
        (share > 0 ? `<span class="wbar ${k}" style="width:${width.toFixed(1)}px"></span>` : '');
      tr.appendChild(cell(html, 'l bar-cell'));
    }
    tr.appendChild(cell(`<span class="qflag ${e.q}">${e.q}</span>`, 'l'));
    body.appendChild(tr);
  }
}

function stamp() {
  const label = monthLabel(TN);
  document.getElementById('asof-txt').textContent = 'Data as of ' + label;
  document.getElementById('foot-asof').textContent = label + ' · 17 elements · 3 indices';
  document.getElementById('rebase-note').textContent = `Index = 100 at ${monthLabel(T0)}`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
stamp();
buildTable();
render();
