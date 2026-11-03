// Taua map: build step. map-src/ (written by export_public.py) → map-build/
// (tiles, territory shapes, data.js, Leaflet). Eleventy copies map-build to /map/.
// Skips the work when map-src and this script haven't changed since the last build.
//
//   node map/build.mjs           build if anything changed
//   node map/build.mjs --force   rebuild everything
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { vectorize } from './vectorize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SRC = path.join(ROOT, 'map-src');
const OUT = path.join(ROOT, 'map-build');
const FORCE = process.argv.includes('--force');

// Map space: full-resolution base map pixels. Leaflet units = full px / 64,
// so zoom 6 is full resolution and zoom 0 is the whole country in about 576 px.
const T = 512;            // output tile size
const ZMAX = 6;           // base map native zoom (full resolution)
const ZW = 5;             // whenua overlay native zoom (about 3 px per fine cell)
const SEA = { r: 46, g: 82, b: 108 };

const log = (...a) => console.log('  ' + a.join(' '));
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const exists = (f) => fs.existsSync(path.join(SRC, f));
const mkdir = (d) => fs.mkdirSync(d, { recursive: true });

function hashInputs() {
  const h = crypto.createHash('sha1');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(path.relative(ROOT, p) + ':' + st.size + ':' + crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(SRC);
  for (const f of ['build.mjs', 'vectorize.mjs', 'viewer.js', 'map.css']) {
    const p = path.join(HERE, f);
    if (fs.existsSync(p)) h.update(f + fs.readFileSync(p));
  }
  return h.digest('hex');
}

// ── base map ──────────────────────────────────────────────────
async function isSea(img) {
  const s = await sharp(img).stats();
  return s.channels.every((c, i) => c.stdev < 1.5 && Math.abs(c.mean - [SEA.r, SEA.g, SEA.b][i]) < 4);
}
// The same test on a raw RGB block of the decoded source tile, without re-encoding.
function blockIsSea(data, stride, left, top) {
  for (let y = 0; y < T; y += 2) {
    let o = ((top + y) * stride + left) * 3;
    for (let x = 0; x < T; x += 2, o += 6) {
      if (Math.abs(data[o] - SEA.r) > 6 || Math.abs(data[o + 1] - SEA.g) > 6 || Math.abs(data[o + 2] - SEA.b) > 6) return false;
    }
  }
  return true;
}

async function baseTiles(meta) {
  const dir = path.join(OUT, 'tiles', 'base');
  const have = {};               // z -> Set("x_y")
  const N = meta.tiles;           // 18 source tiles across
  const per = meta.tile / T;      // 4 output tiles per source tile
  have[ZMAX] = new Set();
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const f = path.join(SRC, 'tiles', `r${r}_c${c}.jpg`);
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    if (await isSea(buf)) continue;
    const raw = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
      if (blockIsSea(raw.data, raw.info.width, i * T, j * T)) continue;
      const sub = sharp(raw.data, { raw: raw.info }).extract({ left: i * T, top: j * T, width: T, height: T });
      const x = c * per + i, y = r * per + j;
      mkdir(path.join(dir, String(ZMAX), String(x)));
      await sub.jpeg({ quality: 82 }).toFile(path.join(dir, String(ZMAX), String(x), `${y}.jpg`));
      have[ZMAX].add(`${x}_${y}`);
    }
  }
  await pyramid(dir, have, ZMAX, 'jpg', { r: SEA.r, g: SEA.g, b: SEA.b, alpha: 1 });
  return have;
}

// Build zoom z from z+1 by halving 2x2 blocks of tiles.
async function pyramid(dir, have, zTop, ext, bg) {
  for (let z = zTop - 1; z >= 0; z--) {
    have[z] = new Set();
    const parents = new Set([...have[z + 1]].map((k) => { const [x, y] = k.split('_').map(Number); return `${x >> 1}_${y >> 1}`; }));
    for (const k of parents) {
      const [x, y] = k.split('_').map(Number);
      const parts = [];
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const ck = `${2 * x + dx}_${2 * y + dy}`;
        if (have[z + 1].has(ck)) parts.push({ input: path.join(dir, String(z + 1), String(2 * x + dx), `${2 * y + dy}.${ext}`), left: dx * T, top: dy * T });
      }
      const big = await sharp({ create: { width: 2 * T, height: 2 * T, channels: 4, background: bg } }).composite(parts).png().toBuffer();
      mkdir(path.join(dir, String(z), String(x)));
      const half = sharp(big).resize(T, T, { kernel: 'lanczos3' });
      const file = path.join(dir, String(z), String(x), `${y}.${ext}`);
      if (ext === 'jpg') await half.flatten({ background: bg }).jpeg({ quality: 82 }).toFile(file);
      else await half.png({ palette: true, compressionLevel: 9 }).toFile(file);
      have[z].add(k);
    }
  }
}

// ── whenua overlay ────────────────────────────────────────────
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

function palette(legend) {
  const col = {};
  for (const k of legend.kits) col[k.id] = hex(k.color);
  col[36] = hex(legend.lake.color);
  const pal = new Uint8Array(37 * 8 * 4);
  for (let k = 1; k < 37; k++) for (let s = 0; s < 8; s++) {
    if (!col[k]) continue;
    let c = col[k];
    const look = legend.looks[String(s)];
    if (look && col[look]) c = mix(c, col[look], 0.75);
    if (s === 3) c = hex(legend.garden);
    const j = (k * 8 + s) * 4;
    pal[j] = c[0]; pal[j + 1] = c[1]; pal[j + 2] = c[2]; pal[j + 3] = 255;
  }
  return pal;
}

async function whenuaTiles(meta, legend) {
  const dir = path.join(OUT, 'tiles', 'whenua');
  const FW = meta.fine;
  const K = zlib.gunzipSync(fs.readFileSync(path.join(SRC, 'whenua_kits.bin.gz')));
  const S = zlib.gunzipSync(fs.readFileSync(path.join(SRC, 'whenua_state.bin.gz')));
  const C = exists('whenua_cliff.bin.gz') ? zlib.gunzipSync(fs.readFileSync(path.join(SRC, 'whenua_cliff.bin.gz'))) : null;
  if (K.length !== FW * FW || S.length !== FW * FW) throw new Error('whenua grid has the wrong size');
  const pal = palette(legend);
  const cliff = hex(legend.cliff);
  const fineDeg = 0.008666666666666666 / 4;       // fine cell, warped degrees
  const cellPx = fineDeg * meta.PPD;               // full-res base px per fine cell (about 6.01)
  const scale = 2 ** (ZMAX - ZW);                   // full px per z5 px
  const n = Math.ceil((meta.tiles * meta.tile) / scale / T);
  const have = { [ZW]: new Set() };
  const buf = Buffer.alloc(T * T * 4);
  const colOf = new Int32Array(T);
  for (let ty = 0; ty < n; ty++) for (let tx = 0; tx < n; tx++) {
    buf.fill(0);
    let any = false;
    for (let i = 0; i < T; i++) colOf[i] = Math.floor(((tx * T + i + 0.5) * scale) / cellPx);
    for (let j = 0; j < T; j++) {
      const r = Math.floor(((ty * T + j + 0.5) * scale) / cellPx);
      if (r >= FW) break;
      const row = r * FW;
      for (let i = 0; i < T; i++) {
        const c = colOf[i];
        if (c >= FW) break;
        const idx = row + c, k = K[idx];
        if (!k) continue;
        const o = (j * T + i) * 4;
        if (C && C[idx]) { buf[o] = cliff[0]; buf[o + 1] = cliff[1]; buf[o + 2] = cliff[2]; buf[o + 3] = 255; any = true; continue; }
        const p = (k * 8 + S[idx]) * 4;
        if (!pal[p + 3]) continue;
        buf[o] = pal[p]; buf[o + 1] = pal[p + 1]; buf[o + 2] = pal[p + 2]; buf[o + 3] = 255;
        any = true;
      }
    }
    if (!any) continue;
    mkdir(path.join(dir, String(ZW), String(tx)));
    await sharp(buf, { raw: { width: T, height: T, channels: 4 } }).png({ palette: true, colours: 256, dither: 0, compressionLevel: 9 })
      .toFile(path.join(dir, String(ZW), String(tx), `${ty}.png`));
    have[ZW].add(`${tx}_${ty}`);
  }
  await pyramid(dir, have, ZW, 'png', { r: 0, g: 0, b: 0, alpha: 0 });
  // Area per kit and state over the whole grid, for the legend.
  const km2 = 0.18 * 0.18; // a fine cell is about 180 m of real ground
  const kitCells = new Array(37).fill(0), stCells = new Array(8).fill(0);
  for (let i = 0; i < K.length; i++) if (K[i]) { kitCells[K[i]]++; stCells[S[i]]++; }
  return { have, kitKm2: kitCells.map((v) => Math.round(v * km2)), stateKm2: stCells.map((v) => Math.round(v * km2)), cliffs: !!C };
}

// ── territories ───────────────────────────────────────────────
function territories(meta) {
  const t = readJson('territory.json');
  const N = t.w * t.h;
  const lab = new Int32Array(N);
  let at = 0;
  for (let i = 0; i < t.rle.length; i += 2) { lab.fill(t.rle[i] - 1, at, at + t.rle[i + 1]); at += t.rle[i + 1]; }
  if (at !== N) throw new Error(`territory grid decodes to ${at} cells, expected ${N}`);
  const vec = vectorize(lab, t.w, t.h, { smooth: 2, radius: 2, tol: 0.12 });
  // vertex (i, j) of the cell grid → Leaflet units (full px / 64)
  const k = (t.cell * meta.PPD) / 64;
  const ox = ((t.w0 - meta.W0) * meta.PPD) / 64, oy = ((meta.N0 - t.n0) * meta.PPD) / 64;
  const pt = ([i, j]) => [Math.round((ox + i * k) * 100) / 100, Math.round((oy + j * k) * 100) / 100];
  const rings = {};
  for (const [l, rs] of vec.rings) rings[l] = rs.map((r) => r.map(pt));
  const arcs = vec.arcs.map((a) => ({ l: a.L, r: a.R, p: a.pts.map(pt) }));
  // cell count per group, for areas
  const cells = new Array(t.groups.length).fill(0);
  for (let i = 0; i < N; i++) if (lab[i] >= 0) cells[lab[i]]++;
  const cellKm2 = 0.9 * 0.9;
  const groups = t.groups.map((g, i) => ({ ...g, km2: Math.round(cells[i] * cellKm2) }));
  // Label points at three levels: each label sits on a cell of its own area,
  // the one nearest the area's centre, so a curved territory never labels the sea.
  const labelsFor = (keyOf, nameOf) => {
    const agg = new Map(), keyIdx = t.groups.map((g) => keyOf(g));
    for (let i = 0; i < N; i++) {
      const l = lab[i]; if (l < 0) continue;
      const k = keyIdx[l]; let a = agg.get(k);
      if (!a) agg.set(k, (a = { sx: 0, sy: 0, n: 0, best: -1, d: Infinity, g: l }));
      a.sx += i % t.w; a.sy += (i / t.w) | 0; a.n++;
    }
    for (const a of agg.values()) { a.mx = a.sx / a.n; a.my = a.sy / a.n; }
    for (let i = 0; i < N; i++) {
      const l = lab[i]; if (l < 0) continue;
      const a = agg.get(keyIdx[l]); const dx = (i % t.w) - a.mx, dy = ((i / t.w) | 0) - a.my, d = dx * dx + dy * dy;
      if (d < a.d) { a.d = d; a.best = i; }
    }
    return [...agg.values()].filter((a) => nameOf(t.groups[a.g])).map((a) => {
      const [x, y] = pt([(a.best % t.w) + 0.5, ((a.best / t.w) | 0) + 0.5]);
      return { name: nameOf(t.groups[a.g]), x, y, km2: Math.round(a.n * cellKm2) };
    }).sort((p, q) => q.km2 - p.km2);
  };
  const labels = {
    conf: labelsFor((g) => g.conf, (g) => g.conf),
    iwi: labelsFor((g) => g.iwi + '|' + g.conf, (g) => g.iwi),
    hapu: labelsFor((g) => g.hapu + '|' + g.iwi, (g) => g.hapu || g.iwi),
  };
  const grid = { w: t.w, h: t.h, w0: t.w0, n0: t.n0, cell: t.cell, rle: t.rle };
  return { groups, rings, arcs, labels, grid };
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(path.join(SRC, 'meta.json'))) { console.log('map: no map-src/meta.json, skipping the map build'); return; }
  const hash = hashInputs();
  const stamp = path.join(OUT, '.inputs');
  if (!FORCE && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) { console.log('map: up to date'); return; }
  console.log('map: building');
  const t0 = Date.now();
  fs.rmSync(OUT, { recursive: true, force: true });
  mkdir(OUT);
  const meta = readJson('meta.json');
  const legend = readJson('whenua_legend.json');

  const base = await baseTiles(meta);
  log('base tiles:', Object.values(base).reduce((a, s) => a + s.size, 0), `(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const wh = await whenuaTiles(meta, legend);
  log('whenua tiles:', Object.values(wh.have).reduce((a, s) => a + s.size, 0), `(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const terr = territories(meta);
  log('territories:', terr.groups.length, 'groups,', terr.arcs.length, 'borders');

  const idx = (have) => Object.fromEntries(Object.entries(have).map(([z, s]) => [z, [...s].sort()]));
  const data = {
    meta: { ...meta, built: new Date().toISOString(), T, ZMAX, ZW, sea: `rgb(${SEA.r},${SEA.g},${SEA.b})`, cliffs: wh.cliffs },
    tiles: { base: idx(base), whenua: idx(wh.have) },
    legend: { ...legend, kitKm2: wh.kitKm2, stateKm2: wh.stateKm2 },
    places: readJson('places.json'),
    landmarks: readJson('landmarks.json'),
    tracks: readJson('tracks.json'),
    territory: terr,
  };
  // A plain script (not JSON + fetch) so the map also opens from a downloaded folder.
  fs.writeFileSync(path.join(OUT, 'data.js'), 'window.TAUA_MAP=' + JSON.stringify(data) + ';\n');
  log('data.js:', Math.round(fs.statSync(path.join(OUT, 'data.js')).size / 1024), 'KB');

  const vendor = path.join(OUT, 'vendor');
  mkdir(vendor);
  // Leaflet 1.9.4 is kept in map/vendor so the map never depends on node_modules.
  for (const f of ['leaflet.js', 'leaflet.css', 'LEAFLET-LICENSE.txt']) fs.copyFileSync(path.join(HERE, 'vendor', f), path.join(vendor, f));
  for (const f of ['viewer.js', 'map.css']) fs.copyFileSync(path.join(HERE, f), path.join(OUT, f));
  fs.writeFileSync(stamp, hash);
  console.log(`map: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
