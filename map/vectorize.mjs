// Label raster → smoothed shared-border arcs and fill rings.
// Ported from the Place Editor's vec.js (v6.2) so the map's territory borders
// match the editor's: borders between two regions are smoothed once, so
// neighbours never gap or overlap, and junctions stay fixed.
export function vectorize(labels, w, h, opt = {}) {
  const W1 = w + 1, nv = W1 * (h + 1);
  const lab = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? -1 : labels[j * w + i]);
  const ea = [], eb = [];
  const adj = new Int32Array(nv * 4).fill(-1), deg = new Uint8Array(nv);
  const addE = (a, b) => { const e = ea.length; ea.push(a); eb.push(b); adj[a * 4 + deg[a]++] = e; adj[b * 4 + deg[b]++] = e; };
  for (let j = 0; j < h; j++) for (let i = -1; i < w; i++) { const a = lab(i, j), b = lab(i + 1, j); if (a !== b && (a >= 0 || b >= 0)) addE(j * W1 + i + 1, (j + 1) * W1 + i + 1); }
  for (let j = -1; j < h; j++) for (let i = 0; i < w; i++) { const a = lab(i, j), b = lab(i, j + 1); if (a !== b && (a >= 0 || b >= 0)) addE((j + 1) * W1 + i, (j + 1) * W1 + i + 1); }
  const seen = new Uint8Array(ea.length), arcs = [];
  const other = (e, v) => (ea[e] === v ? eb[e] : ea[e]);
  const walk = (v0, e0) => {
    const vs = [v0]; let v = v0, e = e0;
    while (true) {
      seen[e] = 1; v = other(e, v); vs.push(v);
      if (deg[v] !== 2 || v === v0) break;
      let ne = -1; for (let t = 0; t < 2; t++) { const c = adj[v * 4 + t]; if (c !== e) ne = c; }
      if (ne < 0 || seen[ne]) break; e = ne;
    }
    return vs;
  };
  for (let v = 0; v < nv; v++) { if (deg[v] === 0 || deg[v] === 2) continue; for (let t = 0; t < deg[v]; t++) { const e = adj[v * 4 + t]; if (!seen[e]) arcs.push({ vs: walk(v, e) }); } }
  for (let e = 0; e < ea.length; e++) if (!seen[e]) arcs.push({ vs: walk(ea[e], e), closed: true });
  const smoothN = opt.smooth == null ? 2 : opt.smooth, R = opt.radius || 2;
  for (const a of arcs) {
    const vs = a.vs; const x0 = vs[0] % W1, y0 = (vs[0] / W1) | 0, x1 = vs[1] % W1, y1 = (vs[1] / W1) | 0;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0;
    a.R = lab(Math.floor(mx - 0.5 * dy), Math.floor(my + 0.5 * dx)); a.L = lab(Math.floor(mx + 0.5 * dy), Math.floor(my - 0.5 * dx));
    let p = vs.map((v) => [v % W1, (v / W1) | 0]); const closed = vs[0] === vs[vs.length - 1];
    for (let pass = 0; pass < smoothN; pass++) {
      const n = p.length, q = p.map((v) => v.slice());
      for (let i = 0; i < n; i++) {
        if (!closed && (i === 0 || i === n - 1)) continue;
        const r = closed ? R : Math.min(R, i, n - 1 - i); if (r < 1) continue;
        let sx = 0, sy = 0, c = 0;
        for (let k = -r; k <= r; k++) { let ii = i + k; if (closed) ii = ((ii % (n - 1)) + (n - 1)) % (n - 1); const wgt = r + 1 - Math.abs(k); sx += p[ii][0] * wgt; sy += p[ii][1] * wgt; c += wgt; }
        q[i] = [sx / c, sy / c];
      }
      if (closed) q[n - 1] = q[0].slice(); p = q;
    }
    a.pts = rdp(p, opt.tol == null ? 0.12 : opt.tol); a.sv = vs[0]; a.ev = vs[vs.length - 1]; delete a.vs;
  }
  const byLab = new Map();
  for (const a of arcs) for (const [lb, fwd] of [[a.R, true], [a.L, false]]) { if (lb < 0) continue; if (!byLab.has(lb)) byLab.set(lb, []); byLab.get(lb).push({ a, fwd }); }
  const rings = new Map();
  for (const [lb, list] of byLab) {
    const out = []; const starts = new Map();
    list.forEach((o, i) => { const s = o.fwd ? o.a.sv : o.a.ev; if (!starts.has(s)) starts.set(s, []); starts.get(s).push(i); });
    const used = new Uint8Array(list.length);
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      const ring = []; let cur = i; const start = list[i].fwd ? list[i].a.sv : list[i].a.ev; let guard = 0;
      while (cur >= 0 && !used[cur] && guard++ < 100000) {
        used[cur] = 1; const o = list[cur]; const pts = o.fwd ? o.a.pts : o.a.pts.slice().reverse();
        for (let k = ring.length ? 1 : 0; k < pts.length; k++) ring.push(pts[k]);
        const end = o.fwd ? o.a.ev : o.a.sv; if (end === start && ring.length > 2) break;
        const cand = (starts.get(end) || []).find((t) => !used[t]); cur = cand === undefined ? -1 : cand;
      }
      if (ring.length > 2) out.push(ring);
    }
    rings.set(lb, out);
  }
  return { arcs, rings };
}

function rdp(p, tol) {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1; const st = [[0, p.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = -1, mi = -1;
    const ax = p[a][0], ay = p[a][1], bx = p[b][0], by = p[b][1], L = Math.hypot(bx - ax, by - ay) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - p[i][1]) - (ax - p[i][0]) * (by - ay)) / L; if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return p.filter((v, i) => keep[i]);
}
