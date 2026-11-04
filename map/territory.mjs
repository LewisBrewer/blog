// 1810 territories, grown the way the Place Editor grows them (computeTerr in
// PlaceEditor_6_north.html): every place with an 1810 holder, other than
// anchorages and plots, is a seed; seeds spread over land by terrain cost
// (multi-source Dijkstra, capped at TERR_CAP), and each cell belongs to the
// nearest seed. Cells of seeds held by the same hapū share a label.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TERR_CAP = 60; // cost units (open fernland: one unit per ~0.9 km)
const TCOST_DEFAULT = { cls: { 2: 1.5, 3: 1.25, 4: 1.0, 5: 0.9, 6: 2.5, 7: 1.3, 8: 1.6, 9: 4, 10: 3, 11: 0.85, 12: 0.8 }, slopeRef: 14, maxSlope: 32, maxElev: 1900, river: { 2: 1.5, 3: 5 }, track: 0.5, riverTrack: 0.8, handImp: 2.5 };
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];

function Heap() { this.k = []; this.d = []; }
Heap.prototype.push = function (key, d) { const K = this.k, D = this.d; let i = K.length; K.push(key); D.push(d); while (i > 0) { const p = (i - 1) >> 1; if (D[p] <= d) break; K[i] = K[p]; D[i] = D[p]; i = p; } K[i] = key; D[i] = d; };
Heap.prototype.pop = function () {
  const K = this.k, D = this.d; const top = K[0], td = D[0]; const lk = K.pop(), ld = D.pop();
  if (K.length) { let i = 0; const n = K.length; while (true) { const l = 2 * i + 1, r = l + 1; let m = i, md = ld; if (l < n && D[l] < md) { m = l; md = D[l]; } if (r < n && D[r] < md) { m = r; md = D[r]; } if (m === i) break; K[i] = K[m]; D[i] = D[m]; i = m; } K[i] = lk; D[i] = ld; }
  this.lastD = td; return top;
};

export function growTerritories(SRC, places, tracks) {
  const gd = JSON.parse(fs.readFileSync(path.join(SRC, 'terrain_grid.json'), 'utf8'));
  const W = gd.w, H = gd.h, N = W * H;
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(SRC, 'terrain_grid.bin.gz')));
  const cls = buf.subarray(0, N), elev = buf.subarray(N, 2 * N), slope = buf.subarray(2 * N, 3 * N), rank = buf.subarray(3 * N, 4 * N);
  const TC = JSON.parse(JSON.stringify(TCOST_DEFAULT));
  const wf = path.join(SRC, 'terrain_cost_weights.json');
  if (fs.existsSync(wf)) { const j = JSON.parse(fs.readFileSync(wf, 'utf8')); Object.assign(TC, j); TC.cls = { ...TCOST_DEFAULT.cls, ...(j.cls || {}) }; TC.river = { ...TCOST_DEFAULT.river, ...(j.river || {}) }; }
  const w2g = (lon, lat) => [(lon - gd.w0) / gd.cell, (gd.n0 - lat) / gd.cell];

  // tracks: 1 = walking track, portage or road; 2 = river (drawn second, so it wins), as gridTracks()
  const track = new Uint8Array(N);
  const stamp = (pts, val) => {
    const R = 0.8; // half the editor's 1.6-cell line width
    for (let s = 1; s < pts.length; s++) {
      const [ax, ay] = w2g(...pts[s - 1]), [bx, by] = w2g(...pts[s]);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + R));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + R));
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
        const cx = i + 0.5, cy = j + 0.5; const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / L2));
        const ex = ax + t * dx - cx, ey = ay + t * dy - cy;
        if (ex * ex + ey * ey <= R * R) track[j * W + i] = val;
      }
    }
  };
  for (const [val, types] of [[1, ['walking_track', 'portage', 'road']], [2, ['river']]])
    for (const t of tracks) if (types.includes(t.type) && t.w.length > 1) stamp(t.w, val);

  // the hand-drawn rough-country areas multiply cost (cell centre inside the polygon)
  const imp = new Uint8Array(N);
  const rough = fs.existsSync(path.join(SRC, 'rough_areas.json')) ? JSON.parse(fs.readFileSync(path.join(SRC, 'rough_areas.json'), 'utf8')) : [];
  for (const poly of rough) {
    const g = poly.map((v) => w2g(v[0], v[1]));
    const ys = g.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
    for (let j = y0; j <= y1; j++) {
      const cy = j + 0.5, xs = [];
      for (let a = 0, b = g.length - 1; a < g.length; b = a++) {
        const [xa, ya] = g[a], [xb, yb] = g[b];
        if ((ya > cy) !== (yb > cy)) xs.push(xa + ((cy - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
        for (let i = i0; i <= i1; i++) imp[j * W + i] = 1;
      }
    }
  }

  // terrain cost, as terrainCost()
  const cost = new Float32Array(N), land = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const cl = cls[k]; land[k] = cl >= 2 ? 1 : 0;
    if (cl < 2) { cost[k] = Infinity; continue; }
    const sl = slope[k] / 4, el = elev[k] * 12;
    if (sl > TC.maxSlope || el > TC.maxElev) { cost[k] = Infinity; continue; }
    let v = (TC.cls[cl] || 1) * (1 + (sl / TC.slopeRef) ** 2);
    if (imp[k]) v *= TC.handImp;
    if (track[k] === 1) v *= TC.track; else if (track[k] === 2) v *= TC.riverTrack;
    cost[k] = v;
  }
  const passable = (k) => land[k] && cost[k] < Infinity;
  const stepCost = (a, b) => { let v = 0.5 * (cost[a] + cost[b]); const rb = rank[b]; if (rb >= 2 && rank[a] < rb && !track[b]) v += TC.river[rb] || 0; return v; };

  // land components, so a place on a sliver of coast joins the mainland (snapCell)
  const comp = new Int32Array(N).fill(-1), size = [], st = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (comp[k0] >= 0 || !passable(k0)) continue;
    const id = size.length; let n = 0; comp[k0] = id; st.push(k0);
    while (st.length) { const k = st.pop(); n++; const i = k % W, j = (k / W) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue; const nk = jj * W + ii; if (comp[nk] < 0 && passable(nk)) { comp[nk] = id; st.push(nk); } } }
    size.push(n);
  }
  const cs = (q) => (comp[q] >= 0 ? size[comp[q]] : 0);
  function snapCell(k, R = 4) {
    if (k < 0) return -1;
    const i0 = k % W, j0 = (k / W) | 0;
    if (passable(k) && cs(k) >= 6) return k;
    let best = -1, bd = 1e9, bestBig = -1, bdBig = 1e9;
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const kk = j * W + i; if (!passable(kk)) continue; const d = di * di + dj * dj;
      if (d < bd) { bd = d; best = kk; } if (cs(kk) >= 6 && d < bdBig) { bdBig = d; bestBig = kk; }
    }
    if (bestBig >= 0 && bdBig <= 8) return bestBig; if (passable(k)) return k; return best;
  }
  const cellOf = (lon, lat) => { const [gx, gy] = w2g(lon, lat); const i = Math.floor(gx), j = Math.floor(gy); return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i; };

  // seeds: places with an 1810 holder
  const groups = [], gIdx = new Map(), seeds = [], seedGroup = [];
  for (const p of places) {
    if (p.type === 'anchorage' || p.type === 'plot' || !p.w) continue;
    const c = (p.occ || []).find((o) => o.role === 'controller');
    if (!c) continue;
    const k = snapCell(cellOf(p.w[0], p.w[1]), 4);
    if (k < 0) continue;
    const key = (c.hapu || '') + '|' + (c.iwi || '') + '|' + (c.conf || '');
    if (!gIdx.has(key)) { gIdx.set(key, groups.length); groups.push({ hapu: c.hapu || '', iwi: c.iwi || '', conf: c.conf || '' }); }
    seeds.push(k); seedGroup.push(gIdx.get(key));
  }

  // spread, as spread(sources, TERR_CAP)
  const own = new Int32Array(N).fill(-1), dist = new Float64Array(N).fill(Infinity), h = new Heap();
  seeds.forEach((k, i) => { if (dist[k] > 0) { dist[k] = 0; own[k] = i; h.push(k, 0); } });
  while (h.k.length) {
    const k = h.pop(), d = h.lastD; if (d > dist[k]) continue; const i = k % W, j = (k / W) | 0;
    for (const [di, dj, c] of NB) {
      const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
      const nk = jj * W + ii; if (!passable(nk)) continue;
      if (di && dj && (!passable(j * W + ii) || !passable(jj * W + i))) continue;
      const nd = d + c * stepCost(k, nk); if (nd > TERR_CAP || nd >= dist[nk]) continue;
      dist[nk] = nd; own[nk] = own[k]; h.push(nk, nd);
    }
  }
  const lab = new Int32Array(N);
  for (let k = 0; k < N; k++) lab[k] = own[k] < 0 ? -1 : seedGroup[own[k]];
  // run-length copy for the viewer's "what's under the pointer" lookup (value = label + 1)
  const rle = [];
  for (let k = 0; k < N; k++) { const v = lab[k] + 1; if (rle.length && rle[rle.length - 2] === v) rle[rle.length - 1]++; else rle.push(v, 1); }
  return { w: W, h: H, w0: gd.w0, n0: gd.n0, cell: gd.cell, groups, lab, rle, seeds: seeds.length, rough: rough.length };
}
