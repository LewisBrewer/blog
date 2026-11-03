/* Taua map viewer: blog.lewisbrewer.com/map/
   Read-only. Data comes from data.js (window.TAUA_MAP), built by map/build.mjs.
   URL parameters: embed=1, p=<place id>, v=<x>,<y>,<zoom>, l=<layers>, c=<conf|iwi|hapu> */
(function () {
  'use strict';
  const D = window.TAUA_MAP;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const params = new URLSearchParams(location.search);
  const EMBED = params.get('embed') === '1';
  const M = D.meta;
  const U = M.PPD / 64;                                   // Leaflet units per warped degree
  const toLL = (w) => L.latLng(-(M.N0 - w[1]) * U, (w[0] - M.W0) * U);
  const fromLL = (ll) => [ll.lng / U + M.W0, M.N0 + ll.lat / U];
  const WORLD = (M.tiles * M.tile) / 64;

  // ── colours ───────────────────────────────────────────────
  const CONF_HUE = {
    'Muriwhenua': 42, 'Ngāpuhi': 8, 'Whangārei': 160, 'Ngāti Whātua': 205, 'Marutūāhu': 275, 'Tainui': 330,
    'Te Arawa': 25, 'Tūwharetoa': 55, 'Tauranga': 185, 'Mātaatua': 125, 'Ngāti Porou': 350, 'Tūranganui-a-Kiwa': 300,
    'Ngāti Kahungunu': 95, 'Taranaki': 225, 'Whanganui': 145, 'Wairiki/Apa': 70, 'Manawatū/Horowhenua': 250,
    'Wellington': 195, 'Te Tau Ihu': 15, 'Ngāi Tahu': 175, 'Mōriori': 110,
  };
  const hash = (s) => { let h = 0; s = s || ''; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  function groupColour(g, mode) {
    const base = CONF_HUE[g.conf] != null ? CONF_HUE[g.conf] : hash(g.conf) % 360;
    if (mode === 'conf') return `hsl(${base},52%,54%)`;
    if (mode === 'iwi') { const h = hash(g.iwi); return `hsl(${(base + (h % 37) - 18 + 360) % 360},${40 + (h >> 5) % 22}%,${44 + (h >> 9) % 20}%)`; }
    const h = hash(g.hapu + '|' + g.iwi); return `hsl(${(base + (h % 61) - 30 + 360) % 360},${36 + (h >> 6) % 30}%,${40 + (h >> 11) % 26}%)`;
  }
  const TRACK = {
    walking_track: { name: 'Walking tracks', color: '#efe6d2', weight: 1.4, dash: '3 4' },
    river: { name: 'Navigable rivers', color: '#8fc4e6', weight: 1.8 },
    sea_lane: { name: 'Sea lanes', color: '#b9d6e6', weight: 1.1, dash: '1 5' },
    portage: { name: 'Portages', color: '#e3a65a', weight: 2.4 },
  };
  const PTYPE = {
    'pā': { name: 'Pā', shape: 'diamond' },
    'kāinga_pā': { name: 'Kāinga with a pā', shape: 'square' },
    'kāinga': { name: 'Kāinga', shape: 'circle' },
    'anchorage': { name: 'Anchorage', shape: 'ring' },
    '': { name: 'Place, type not set', shape: 'dot' },
  };
  const typeName = (t) => (PTYPE[t] || PTYPE['']).name;

  // ── state ─────────────────────────────────────────────────
  const LAYER_CODES = { whenua: 'w', territory: 't', places: 's', landmarks: 'm', tracks: 'k' };
  const S = {
    on: { whenua: false, territory: true, places: true, landmarks: true, tracks: false },
    types: { 'pā': true, 'kāinga_pā': true, 'kāinga': true, 'anchorage': true, '': true },
    trackTypes: { walking_track: true, river: true, sea_lane: true, portage: true },
    colour: 'conf', whenuaOpacity: 0.7, sel: null,
  };
  if (params.get('l') != null) {
    const l = params.get('l');
    for (const [k, c] of Object.entries(LAYER_CODES)) S.on[k] = l.includes(c);
  }
  if (['conf', 'iwi', 'hapu'].includes(params.get('c'))) S.colour = params.get('c');
  try { const o = parseFloat(localStorage.getItem('tauaMap.whenuaOpacity')); if (o >= 0.1 && o <= 1) S.whenuaOpacity = o; } catch (e) { /* storage blocked */ }

  // ── map ───────────────────────────────────────────────────
  document.documentElement.classList.toggle('is-embed', EMBED);
  const map = L.map('map', {
    crs: L.CRS.Simple, minZoom: -1, maxZoom: 8, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90,
    zoomControl: false, attributionControl: false, preferCanvas: true, maxBoundsViscosity: 0.8,
    scrollWheelZoom: !EMBED, worldCopyJump: false,
  });
  map.setMaxBounds([[-WORLD * 1.05, -WORLD * 0.05], [WORLD * 0.05, WORLD * 1.05]]);
  $('#map').style.background = M.sea;

  const IndexedTiles = L.TileLayer.extend({
    initialize(url, have, opts) { L.TileLayer.prototype.initialize.call(this, url, opts); this._have = {}; for (const [z, ks] of Object.entries(have)) this._have[z] = new Set(ks); },
    createTile(coords, done) {
      const set = this._have[coords.z];
      if (!set || !set.has(coords.x + '_' + coords.y)) { const d = document.createElement('div'); setTimeout(() => done(null, d), 0); return d; }
      return L.TileLayer.prototype.createTile.call(this, coords, done);
    },
  });
  const worldBounds = L.latLngBounds([[-WORLD, 0], [0, WORLD]]);
  const base = new IndexedTiles('tiles/base/{z}/{x}/{y}.jpg', D.tiles.base, {
    tileSize: M.T, minNativeZoom: 0, maxNativeZoom: M.ZMAX, noWrap: true, bounds: worldBounds, keepBuffer: 3, updateWhenZooming: false,
  }).addTo(map);
  map.createPane('whenua').style.zIndex = 250;
  const whenua = new IndexedTiles('tiles/whenua/{z}/{x}/{y}.png', D.tiles.whenua, {
    pane: 'whenua', tileSize: M.T, minNativeZoom: 0, maxNativeZoom: M.ZW, noWrap: true, bounds: worldBounds,
    opacity: S.whenuaOpacity, className: 'whenua-tiles', updateWhenZooming: false,
  });

  // ── territories ───────────────────────────────────────────
  const G = D.territory.groups;
  const terrRenderer = L.canvas({ padding: 0.3, tolerance: 0 });
  map.createPane('terr').style.zIndex = 300;
  const terrFill = L.layerGroup();
  const terrPolys = [];
  for (const [l, rings] of Object.entries(D.territory.rings)) {
    const g = G[+l];
    const poly = L.polygon(rings.map((r) => r.map(([x, y]) => [-y, x])), {
      renderer: terrRenderer, pane: 'terr', stroke: false, fillOpacity: 0.34, fillRule: 'evenodd', smoothFactor: 0.6, interactive: false,
    });
    poly._group = +l;
    terrPolys.push(poly);
    terrFill.addLayer(poly);
  }
  const borderLayer = L.layerGroup();
  const borders = { conf: [], iwi: [], hapu: [] };
  for (const a of D.territory.arcs) {
    if (a.l < 0 || a.r < 0) continue;                         // coast: the base map draws it
    const gl = G[a.l], gr = G[a.r];
    const k = gl.conf !== gr.conf ? 'conf' : gl.iwi !== gr.iwi ? 'iwi' : 'hapu';
    borders[k].push(a.p.map(([x, y]) => [-y, x]));
  }
  const BSTYLE = { conf: { color: '#f4efe6', weight: 1.6, opacity: 0.75 }, iwi: { color: '#f4efe6', weight: 0.9, opacity: 0.5 }, hapu: { color: '#f4efe6', weight: 0.5, opacity: 0.32, dashArray: '2 3' } };
  for (const k of ['hapu', 'iwi', 'conf']) borderLayer.addLayer(L.polyline(borders[k], { renderer: terrRenderer, pane: 'terr', interactive: false, smoothFactor: 0.6, ...BSTYLE[k] }));
  function recolour() {
    for (const p of terrPolys) {
      const g = G[p._group];
      const sel = S.sel && S.sel.kind === 'group' && sameGroup(S.sel.id, p._group);
      p.setStyle({ fillColor: groupColour(g, S.colour), fillOpacity: sel ? 0.6 : S.on.whenua ? 0.06 : 0.38 });
    }
  }
  const sameGroup = (a, b) => a === b;
  // Which territory is under a point: read the label grid rather than hit-testing polygons.
  const TG = D.territory.grid, TL = new Uint16Array(TG.w * TG.h);
  for (let i = 0, at = 0; i < TG.rle.length; i += 2) { TL.fill(TG.rle[i], at, at + TG.rle[i + 1]); at += TG.rle[i + 1]; }
  function groupAt(ll) {
    const w = fromLL(ll), c = Math.floor((w[0] - TG.w0) / TG.cell), r = Math.floor((TG.n0 - w[1]) / TG.cell);
    if (c < 0 || r < 0 || c >= TG.w || r >= TG.h) return -1;
    return TL[r * TG.w + c] - 1;
  }

  // ── tracks ────────────────────────────────────────────────
  const ptRenderer = L.canvas({ padding: 0.3, tolerance: 6 });
  map.createPane('points').style.zIndex = 450;
  let lastHit = 0;                                           // a click on a point or track, so the map click ignores it
  const trackLayer = L.layerGroup();
  const trackLines = [];
  for (const t of D.tracks) {
    const st = TRACK[t.type] || TRACK.walking_track;
    const line = L.polyline(t.w.map(toLL), { renderer: ptRenderer, pane: 'points', color: st.color, weight: st.weight, opacity: 0.9, dashArray: st.dash, smoothFactor: 1 });
    line._t = t;
    line.on('click', () => { lastHit = Date.now(); select({ kind: 'track', id: t.id }); });
    line.bindTooltip(esc(t.name || TRACK[t.type]?.name || 'Track'), { sticky: true, className: 'tm-tip', opacity: 1 });
    trackLines.push(line);
  }
  function refreshTracks() {
    trackLayer.clearLayers();
    for (const l of trackLines) if (S.trackTypes[l._t.type] !== false) trackLayer.addLayer(l);
  }

  // ── points: places and landmarks ──────────────────────────
  L.Canvas.include({
    _updateShape(layer) {
      if (!this._drawing || layer._empty()) return;
      const p = layer._point, ctx = this._ctx, r = Math.max(layer._radius, 1);
      ctx.beginPath();
      switch (layer.options.shape) {
        case 'diamond': { const d = r * 1.3; ctx.moveTo(p.x, p.y - d); ctx.lineTo(p.x + d, p.y); ctx.lineTo(p.x, p.y + d); ctx.lineTo(p.x - d, p.y); ctx.closePath(); break; }
        case 'square': { const d = r * 0.95; ctx.rect(p.x - d, p.y - d, 2 * d, 2 * d); break; }
        case 'triangle': { const d = r * 1.35; ctx.moveTo(p.x, p.y - d); ctx.lineTo(p.x + d * 0.92, p.y + d * 0.62); ctx.lineTo(p.x - d * 0.92, p.y + d * 0.62); ctx.closePath(); break; }
        default: ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      this._fillStroke(ctx, layer);
    },
  });
  const Shape = L.CircleMarker.extend({ _updatePath() { this._renderer._updateShape(this); } });
  const placeLayer = L.layerGroup(), landmarkLayer = L.layerGroup();
  const PL = new Map(), LM = new Map();
  const holder = (p) => (p.occ || []).find((o) => o.role === 'controller') || (p.occ || []).find((o) => !o.role);
  const isSeat = (p) => (p.occ || []).some((o) => o.seat && (o.role === 'controller' || !o.role));
  function placeStyle(p, z) {
    const t = PTYPE[p.type] ? p.type : '';
    const seat = isSeat(p);
    const r = Math.max(2.2, Math.min(7, 1.6 + z * 0.85)) + (seat ? 1.2 : 0) - (t === '' || t === 'anchorage' ? 0.6 : 0);
    const unconf = (p.flags || []).includes('unconfirmed');
    const approx = (p.flags || []).includes('approx');
    const o = { renderer: ptRenderer, pane: 'points', radius: r, shape: PTYPE[t].shape, weight: 1.2, color: '#0b0b0b', fillColor: seat ? '#d12229' : '#f2ede4', fillOpacity: approx ? 0.6 : 1, opacity: 1, dashArray: null };
    if (t === 'anchorage') Object.assign(o, { shape: 'circle', fillColor: '#0b0b0b', fillOpacity: 0.35, color: '#b9d6e6', weight: 1.6 });
    if (t === '') Object.assign(o, { shape: 'circle', fillColor: '#bdb6aa', weight: 1 });
    if (unconf) Object.assign(o, { dashArray: '2.5 2', color: '#e5c48a', weight: 1.5 });
    return o;
  }
  for (const p of D.places) {
    p.ll = toLL(p.w); p.h = holder(p); p.seat = isSeat(p);
    const m = new Shape(p.ll, placeStyle(p, 2));
    m._p = p;
    m.on('click', () => { lastHit = Date.now(); select({ kind: 'place', id: p.id }); });
    PL.set(p.id, m);
  }
  for (const l of D.landmarks) {
    l.ll = toLL(l.w);
    const m = new Shape(l.ll, { renderer: ptRenderer, pane: 'points', radius: 4, shape: 'triangle', weight: l.consult ? 2 : 1.1, color: l.consult ? '#ff5a5f' : '#0b0b0b', fillColor: '#e5c48a', fillOpacity: l.approx ? 0.6 : 1 });
    m._l = l;
    m.on('click', () => { lastHit = Date.now(); select({ kind: 'landmark', id: l.id }); });
    LM.set(l.id, m);
  }
  function refreshPoints() {
    const z = map.getZoom();
    placeLayer.clearLayers();
    for (const m of PL.values()) {
      const p = m._p, t = PTYPE[p.type] ? p.type : '';
      if (!S.types[t]) continue;
      if (z < 2 && !p.seat) continue;                         // thin out the country view
      if (z < 3 && !p.seat && t !== 'pā' && t !== 'kāinga_pā') continue;
      m.setStyle(placeStyle(p, z)); m.setRadius(placeStyle(p, z).radius);
      placeLayer.addLayer(m);
    }
    landmarkLayer.clearLayers();
    if (S.on.landmarks) for (const m of LM.values()) { if (z < 1.75 && !m._l.consult) continue; m.setRadius(Math.max(3, Math.min(6.5, 2.2 + z * 0.75))); landmarkLayer.addLayer(m); }
  }

  // selection halo
  const halo = L.circleMarker([0, 0], { renderer: ptRenderer, pane: 'points', radius: 12, color: '#ff5a5f', weight: 2.5, fill: false, interactive: false });

  // ── labels (one canvas, collision-checked) ────────────────
  const LabelLayer = L.Layer.extend({
    onAdd(m) {
      this._c = L.DomUtil.create('canvas', 'tm-labels');
      const pane = m.getPane('labels') || m.createPane('labels');
      pane.style.zIndex = 460; pane.style.pointerEvents = 'none';
      pane.appendChild(this._c);
      m.on('moveend zoomend resize', this._draw, this); m.on('zoomstart', this._hide, this);
      this._draw();
    },
    onRemove(m) { L.DomUtil.remove(this._c); m.off('moveend zoomend resize', this._draw, this); m.off('zoomstart', this._hide, this); },
    _hide() { this._c.style.visibility = 'hidden'; },
    _draw() {
      const m = this._map, size = m.getSize(), dpr = window.devicePixelRatio || 1, c = this._c;
      c.width = size.x * dpr; c.height = size.y * dpr; c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0]));
      c.style.visibility = 'visible';
      const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const z = m.getZoom(), boxes = [];
      const free = (b) => !boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
      const put = (text, pt, font, fill, opt = {}) => {
        ctx.font = font;
        const w = ctx.measureText(text).width + (opt.track ? text.length * opt.track : 0), h = opt.h || 12;
        const x = opt.center ? pt.x - w / 2 : pt.x + (opt.dx || 7), y = opt.center ? pt.y : pt.y + (opt.dy || 0);
        const b = [x - 3, y - h / 2 - 2, x + w + 3, y + h / 2 + 2];
        if (b[2] < 0 || b[0] > size.x || b[3] < 0 || b[1] > size.y || !free(b)) return false;
        boxes.push(b);
        if (opt.track && 'letterSpacing' in ctx) ctx.letterSpacing = opt.track + 'px';
        ctx.lineJoin = 'round'; ctx.textBaseline = 'middle';
        ctx.strokeStyle = opt.halo || 'rgba(0,0,0,0.78)'; ctx.lineWidth = opt.haloW || 3; ctx.strokeText(text, x, y);
        ctx.fillStyle = fill; ctx.fillText(text, x, y);
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        return true;
      };
      const vis = m.getBounds().pad(0.1);
      // selected thing first so it always gets its label
      const sel = currentThing();
      if (sel && sel.ll) put(sel.name, m.latLngToContainerPoint(sel.ll), '600 13px Inter, system-ui, sans-serif', '#ffffff', { halo: 'rgba(0,0,0,0.9)' });
      // territory names
      if (S.on.territory) {
        const level = z < 1.75 ? 'conf' : z < 3.25 ? 'iwi' : 'hapu';
        const items = D.territory.labels[level];
        const font = level === 'conf' ? (size.x < 720 ? '15px' : '19px') + ' "BN Romaine", Georgia, serif' : level === 'iwi' ? '600 11.5px Inter, system-ui, sans-serif' : '500 10.5px Inter, system-ui, sans-serif';
        const fill = level === 'conf' ? 'rgba(244,239,230,0.92)' : 'rgba(244,239,230,0.8)';
        for (const it of items) {
          const ll = L.latLng(-it.y, it.x);
          if (!vis.contains(ll)) continue;
          if (level === 'hapu' && it.km2 < (z < 4.25 ? 60 : 8)) continue;
          if (level === 'iwi' && it.km2 < (z < 2.5 ? 900 : 200)) continue;
          put(level === 'conf' ? it.name : it.name, m.latLngToContainerPoint(ll), font, fill, { center: true, track: level === 'conf' ? 1.5 : level === 'iwi' ? 0.6 : 0, h: level === 'conf' ? 22 : 12, halo: 'rgba(0,0,0,0.55)', haloW: level === 'conf' ? 4 : 3 });
        }
      }
      // landmarks
      if (S.on.landmarks && z >= 2.5) {
        for (const l of D.landmarks) if (vis.contains(l.ll)) put(l.name.replace(/\s*\(.*\)$/, ''), m.latLngToContainerPoint(l.ll), 'italic 500 11px Inter, system-ui, sans-serif', '#ecd3a2', { dx: 8 });
      }
      // places, most important first
      if (S.on.places && z >= 2.75) {
        const rank = (p) => (p.seat ? 0 : p.type === 'pā' || p.type === 'kāinga_pā' ? 1 : p.type === 'kāinga' ? 2 : 3);
        const list = D.places.filter((p) => S.types[PTYPE[p.type] ? p.type : ''] && vis.contains(p.ll) && rank(p) <= (z < 3.75 ? 0 : z < 4.75 ? 1 : z < 5.5 ? 2 : 3));
        list.sort((a, b) => rank(a) - rank(b));
        for (const p of list) put(p.name, m.latLngToContainerPoint(p.ll), (p.seat ? '600 ' : '500 ') + '11.5px Inter, system-ui, sans-serif', p.seat ? '#ffffff' : '#ece6dc', { dx: 8 });
      }
    },
  });
  const labels = new LabelLayer();

  // ── layer visibility ──────────────────────────────────────
  function applyLayers() {
    const tog = (on, layer) => (on ? map.hasLayer(layer) || layer.addTo(map) : map.removeLayer(layer));
    tog(S.on.whenua, whenua);
    tog(S.on.territory, terrFill); tog(S.on.territory, borderLayer);
    if (S.on.tracks) refreshTracks();
    tog(S.on.tracks, trackLayer);
    tog(S.on.places, placeLayer); tog(S.on.landmarks, landmarkLayer);
    recolour(); refreshPoints();
    if (map.hasLayer(labels)) labels._draw();
    renderLegend();
    for (const [k, v] of Object.entries(S.on)) { const i = $(`[data-layer="${k}"]`); if (i) i.checked = v; }
    $('#tm-whenua-op').closest('.tm-sub').hidden = !S.on.whenua;
    $('#tm-colour').closest('.tm-sub').hidden = !S.on.territory;
    $('#tm-types').hidden = !S.on.places;
    $('#tm-track-types').hidden = !S.on.tracks;
  }

  // ── detail panel ──────────────────────────────────────────
  const panel = $('#tm-panel'), body = $('#tm-panel-body');
  const groupsOf = (pred) => G.map((g, i) => [g, i]).filter(([g]) => pred(g));
  const placesOfGroup = (g) => D.places.filter((p) => p.h && p.h.hapu === g.hapu && p.h.iwi === g.iwi);
  function currentThing() {
    const s = S.sel; if (!s) return null;
    if (s.kind === 'place') { const p = PL.get(s.id); return p && { name: p._p.name, ll: p._p.ll }; }
    if (s.kind === 'landmark') { const l = LM.get(s.id); return l && { name: l._l.name, ll: l._l.ll }; }
    return null;
  }
  const chip = (cls, text, title) => `<span class="tm-chip ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
  const STATUS = { confirmed: 'Confirmed', needs_confirm: 'Unconfirmed' };
  const linkify = (t) => esc(t).replace(/https?:\/\/[^\s)]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}${u.length > 56 ? '…' : ''}</a>`).replace(/\n/g, '<br>');
  const row = (k, v) => (v || v === 0 ? `<div class="tm-kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>` : '');
  const fortWord = ['none', 'slight', 'some', 'strong', 'very strong', 'a stronghold'];
  function occBlock(o, title) {
    const g = [o.hapu, o.iwi].filter(Boolean);
    const gi = G.findIndex((x) => x.hapu === o.hapu && x.iwi === o.iwi);
    const name = gi >= 0 ? `<a href="#" data-group="${gi}">${esc(o.hapu || o.iwi)}</a>` : esc(o.hapu || o.iwi || o.kind || '');
    return `<section class="tm-occ ${o.status === 'needs_confirm' ? 'is-unconf' : ''}">
      <h3>${esc(title)}</h3>
      <p class="tm-occ-name">${name}${o.hapu && o.iwi ? `<span>${esc(o.iwi)}</span>` : ''}${o.conf ? `<span>${esc(o.conf)}</span>` : ''}</p>
      <dl>${row('Rangatira', o.rangatira ? esc(o.rangatira) : o.seat ? '<i>seat empty in the data</i>' : '')}${row('Population', o.pop ? `about ${o.pop.toLocaleString('en-NZ')} <i>(model estimate)</i>` : '')}
      ${row('Status', `${chip(o.status === 'needs_confirm' ? 'is-unconf' : 'is-ok', STATUS[o.status] || o.status || 'not recorded')}${o.confidence ? ` <i>${esc(o.confidence)}</i>` : ''}`)}
      ${row('Source', o.source ? linkify(o.source) : '')}${row('Basis', o.basis ? linkify(o.basis) : '')}${row('Also', o.affiliated ? esc(o.affiliated) : '')}</dl>
      ${o.notes ? `<details><summary>Notes</summary><p>${linkify(o.notes)}</p></details>` : ''}
      ${g.length ? '' : ''}</section>`;
  }
  function placeHTML(p) {
    const f = p.flags || [];
    const holders = (p.occ || []).filter((o) => o.role === 'controller' || !o.role);
    const residents = (p.occ || []).filter((o) => o.role === 'resident');
    const vacated = (p.occ || []).filter((o) => o.role === 'vacated');
    return `<p class="tm-kind">${esc(typeName(p.type))}${p.seat ? ' · hapū seat' : ''}</p>
      <h2>${esc(p.name)}</h2>${p.aka ? `<p class="tm-aka">Also ${esc(p.aka)}</p>` : ''}
      <p class="tm-chips">${f.includes('unconfirmed') ? chip('is-unconf', '1810 holder unconfirmed') : ''}${f.includes('approx') ? chip('is-approx', 'Approximate location') : ''}${f.includes('placeholder') ? chip('is-approx', 'Placeholder site') : ''}</p>
      ${holders.length ? holders.map((o) => occBlock(o, o.role ? 'Held in 1810 by' : 'Holder (role not recorded)')).join('') : `<section class="tm-occ is-empty"><h3>Held in 1810 by</h3><p>No holder recorded for 1810.</p></section>`}
      ${residents.map((o) => occBlock(o, 'Also living here')).join('')}
      ${vacated.map((o) => occBlock(o, 'Empty in 1810, belongs to')).join('')}
      <section class="tm-facts"><dl>
        ${row('Size', esc(p.size))}${row('Features', esc(p.features))}
        ${row('Defences', p.fortN != null || p.fortB != null ? `natural ${fortWord[p.fortN || 0]}, built ${fortWord[p.fortB || 0]}` : '')}
        ${row('Refuge pā', (p.refuge || []).map(esc).join(', '))}
        ${row('Location', esc(p.coordSrc || p.coord))}
      </dl></section>
      ${p.notes ? `<details class="tm-notes" open><summary>Research notes</summary><p>${linkify(p.notes)}</p></details>` : ''}
      ${p.check ? `<details class="tm-notes"><summary>Still to check</summary><p>${linkify(p.check)}</p></details>` : ''}
      ${(p.src || []).length ? `<section class="tm-src"><h3>Sources</h3><ul>${p.src.map((u) => `<li>${linkify(u)}</li>`).join('')}</ul></section>` : ''}`;
  }
  function landmarkHTML(l) {
    return `<p class="tm-kind">Landmark${l.cat ? ' · ' + esc(l.cat) : ''}</p><h2>${esc(l.name)}</h2>
      <p class="tm-chips">${l.consult ? chip('is-consult', 'Consult mana whenua before modelling') : ''}${l.approx ? chip('is-approx', 'Approximate location') : ''}</p>
      ${l.why ? `<p class="tm-lede">${esc(l.why)}</p>` : ''}
      <section class="tm-facts"><dl>${row('Region', esc(l.region))}${row('Iwi', esc(l.iwi))}${row('Source', l.source ? linkify(l.source) : '')}</dl></section>
      ${l.consult ? `<p class="tm-note">This is a site of particular significance. It is shown so reviewers can see what the game plans to represent, and it will not be modelled without the agreement of the hapū who hold its kōrero.</p>` : ''}`;
  }
  function trackHTML(t) {
    return `<p class="tm-kind">${esc((TRACK[t.type] || {}).name || 'Track').replace(/s$/, '')}</p><h2>${esc(t.name || 'Unnamed track')}</h2>
      <p class="tm-chips">${t.status === 'needs_confirm' ? chip('is-unconf', 'Unconfirmed') : chip('is-ok', 'Confirmed')}</p>
      <section class="tm-facts"><dl>${row('Source', t.source ? linkify(t.source) : '')}</dl></section>
      ${t.notes ? `<details class="tm-notes" open><summary>Notes</summary><p>${linkify(t.notes)}</p></details>` : ''}`;
  }
  function groupHTML(gi) {
    const g = G[gi];
    const title = g.hapu || g.iwi, kind = g.hapu ? 'Hapū' : 'Iwi';
    const members = groupsOf((x) => x.iwi === g.iwi && x.conf === g.conf);
    const held = placesOfGroup(g).sort((a, b) => (b.seat - a.seat) || a.name.localeCompare(b.name, 'mi'));
    const km2 = G[gi].km2;
    return `<p class="tm-kind">${kind} territory, 1810</p><h2>${esc(title)}</h2>
      <p class="tm-aka">${esc(g.hapu ? g.iwi : '')}${g.conf ? (g.hapu ? ' · ' : '') + esc(g.conf) : ''}</p>
      <section class="tm-facts"><dl>${row('Area', km2 ? `about ${km2.toLocaleString('en-NZ')} km² on the game map` : '')}${row('Places held', held.length || '')}</dl></section>
      ${held.length ? `<section class="tm-list"><h3>Places held in 1810</h3><ul>${held.map((p) => `<li><a href="#" data-place="${p.id}">${esc(p.name)}</a><span>${esc(typeName(p.type))}${p.seat ? ' · seat' : ''}</span></li>`).join('')}</ul></section>` : ''}
      ${members.length > 1 ? `<section class="tm-list"><h3>Other ${esc(g.iwi)} hapū on the map</h3><ul class="tm-inline">${members.filter(([x, i]) => i !== gi).map(([x, i]) => `<li><a href="#" data-group="${i}">${esc(x.hapu || x.iwi)}</a></li>`).join('')}</ul></section>` : ''}
      <p class="tm-note">Territory is modelled: each block of land follows the 1810 holder of its nearest place. It is not a boundary claim.</p>`;
  }
  function openPanel(html) {
    body.innerHTML = html + `<footer class="tm-panel-foot"><p>Hold kōrero about this? Corrections and sources are welcome: <a href="mailto:brewer.lewis@gmail.com?subject=${encodeURIComponent('Taua map: ' + (currentThing()?.name || ''))}">get in touch</a>.</p><button type="button" class="tm-link" data-share>Copy a link to this</button></footer>`;
    panel.hidden = false; document.documentElement.classList.add('has-panel');
    body.scrollTop = 0;
    setSheet(window.innerWidth < 720 ? 'peek' : 'open');
  }
  function closePanel() {
    S.sel = null; panel.hidden = true; document.documentElement.classList.remove('has-panel');
    map.removeLayer(halo); recolour(); if (map.hasLayer(labels)) labels._draw(); syncURL();
  }
  function select(s, opts = {}) {
    S.sel = s;
    let ll = null;
    if (s.kind === 'place') { const m = PL.get(s.id); if (!m) return; openPanel(placeHTML(m._p)); ll = m._p.ll; }
    else if (s.kind === 'landmark') { const m = LM.get(s.id); if (!m) return; openPanel(landmarkHTML(m._l)); ll = m._l.ll; }
    else if (s.kind === 'track') { const t = D.tracks.find((x) => x.id === s.id); if (!t) return; openPanel(trackHTML(t)); }
    else if (s.kind === 'group') openPanel(groupHTML(s.id));
    if (ll) { halo.setLatLng(ll).addTo(map); if (opts.fly) map.flyTo(ll, Math.max(map.getZoom(), 4.5), { duration: 0.6 }); }
    else map.removeLayer(halo);
    recolour(); if (map.hasLayer(labels)) labels._draw(); syncURL();
  }
  function selectGroup(gi) { select({ kind: 'group', id: gi }); }
  body.addEventListener('click', (e) => {
    const a = e.target.closest('[data-place],[data-group],[data-share]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.place) select({ kind: 'place', id: a.dataset.place }, { fly: true });
    else if (a.dataset.group) { const gi = +a.dataset.group; select({ kind: 'group', id: gi }); flyToGroup(gi); }
    else if (a.dataset.share) share(a);
  });
  function flyToGroup(gi) {
    const rings = D.territory.rings[gi]; if (!rings) return;
    const b = L.latLngBounds(rings.flat().map(([x, y]) => [-y, x]));
    map.flyToBounds(b, { padding: [40, 40], maxZoom: 5, duration: 0.6 });
  }
  $('#tm-panel-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#tm-about').hidden) toggleAbout(false); else if (S.sel) closePanel(); }
    if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); }
  });

  // bottom sheet on phones: tap or drag the handle between peek and full
  let sheet = 'open';
  function setSheet(s) { sheet = s; panel.dataset.sheet = s; }
  (function sheetDrag() {
    const h = $('#tm-panel-handle'); let y0 = null, s0;
    h.addEventListener('click', () => setSheet(sheet === 'peek' ? 'full' : 'peek'));
    h.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; s0 = sheet; }, { passive: true });
    h.addEventListener('touchmove', (e) => { if (y0 == null) return; const dy = e.touches[0].clientY - y0; if (dy < -40) setSheet('full'); else if (dy > 60) { if (s0 === 'full') setSheet('peek'); else closePanel(); y0 = null; } }, { passive: true });
    h.addEventListener('touchend', () => { y0 = null; });
  })();

  // ── search ────────────────────────────────────────────────
  const search = $('#tm-search'), results = $('#tm-results');
  const index = [];
  for (const p of D.places) index.push({ k: 'place', id: p.id, name: p.name, sub: [typeName(p.type), p.h ? p.h.hapu || p.h.iwi : ''].filter(Boolean).join(' · '), f: fold(p.name + ' ' + (p.aka || '')) });
  for (const p of D.places) for (const o of p.occ || []) if (o.rangatira) index.push({ k: 'place', id: p.id, name: o.rangatira, sub: `Rangatira · ${p.name}`, f: fold(o.rangatira) });
  for (const l of D.landmarks) index.push({ k: 'landmark', id: l.id, name: l.name, sub: ['Landmark', l.cat].filter(Boolean).join(' · '), f: fold(l.name) });
  G.forEach((g, i) => { if (g.hapu) index.push({ k: 'group', id: i, name: g.hapu, sub: ['Hapū', g.iwi].filter(Boolean).join(' · '), f: fold(g.hapu) }); });
  const iwiSeen = new Set();
  G.forEach((g, i) => { const key = g.iwi + '|' + g.conf; if (g.iwi && !iwiSeen.has(key)) { iwiSeen.add(key); index.push({ k: 'iwi', id: i, name: g.iwi, sub: ['Iwi', g.conf].filter(Boolean).join(' · '), f: fold(g.iwi) }); } });
  let hits = [], cursor = 0;
  function runSearch() {
    const q = fold(search.value.trim());
    if (q.length < 2) { results.hidden = true; return; }
    const score = (x) => (x.f.startsWith(q) ? 0 : x.f.includes(' ' + q) ? 1 : x.f.includes(q) ? 2 : 9);
    hits = index.map((x) => [score(x), x]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0] || (a[1].k === 'iwi' ? -1 : 0) || a[1].name.length - b[1].name.length).slice(0, 12).map((x) => x[1]);
    cursor = 0;
    results.innerHTML = hits.length ? hits.map((h, i) => `<li role="option" id="tm-r${i}" aria-selected="${i === 0}" data-i="${i}"><b>${esc(h.name)}</b><span>${esc(h.sub)}</span></li>`).join('') : `<li class="tm-none">No match. Try without macrons, or a hapū or iwi name.</li>`;
    results.hidden = false;
  }
  function pick(h) {
    results.hidden = true; search.blur();
    if (h.k === 'place' || h.k === 'landmark') select({ kind: h.k, id: h.id }, { fly: true });
    else if (h.k === 'group') { select({ kind: 'group', id: h.id }); flyToGroup(h.id); }
    else if (h.k === 'iwi') {
      const g = G[h.id];
      if (S.colour === 'conf') { S.colour = 'iwi'; $('#tm-colour').value = 'iwi'; }
      if (!S.on.territory) { S.on.territory = true; applyLayers(); }
      const gis = groupsOf((x) => x.iwi === g.iwi && x.conf === g.conf).map(([, i]) => i);
      const b = L.latLngBounds(gis.flatMap((i) => (D.territory.rings[i] || []).flat().map(([x, y]) => [-y, x])));
      select({ kind: 'group', id: h.id }); if (b.isValid()) map.flyToBounds(b, { padding: [40, 40], maxZoom: 5, duration: 0.6 });
    }
  }
  search.addEventListener('input', runSearch);
  search.addEventListener('focus', runSearch);
  search.addEventListener('keydown', (e) => {
    if (results.hidden || !hits.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); cursor = (cursor + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
      $$('li', results).forEach((li, i) => li.setAttribute('aria-selected', i === cursor));
      search.setAttribute('aria-activedescendant', 'tm-r' + cursor);
    } else if (e.key === 'Enter') { e.preventDefault(); pick(hits[cursor]); }
    else if (e.key === 'Escape') { results.hidden = true; }
  });
  results.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(hits[+li.dataset.i]); } });
  search.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
  $('#tm-search-open')?.addEventListener('click', () => { document.documentElement.classList.add('search-open'); search.focus(); });
  search.addEventListener('blur', () => setTimeout(() => document.documentElement.classList.remove('search-open'), 160));

  // ── layers panel and legend ───────────────────────────────
  const layersBox = $('#tm-layers');
  $$('[data-layer]').forEach((i) => i.addEventListener('change', () => { S.on[i.dataset.layer] = i.checked; applyLayers(); syncURL(); }));
  $('#tm-colour').value = S.colour;
  $('#tm-colour').addEventListener('change', (e) => { S.colour = e.target.value; recolour(); renderLegend(); syncURL(); });
  const op = $('#tm-whenua-op'); op.value = Math.round(S.whenuaOpacity * 100);
  op.addEventListener('input', () => { S.whenuaOpacity = op.value / 100; whenua.setOpacity(S.whenuaOpacity); try { localStorage.setItem('tauaMap.whenuaOpacity', S.whenuaOpacity); } catch (e) { /* ignore */ } });
  $('#tm-types').innerHTML = Object.entries(PTYPE).map(([t, v]) => `<label class="tm-check sm"><input type="checkbox" data-type="${t}" ${S.types[t] ? 'checked' : ''}><svg class="tm-glyph" viewBox="0 0 16 16" aria-hidden="true">${glyph(v.shape, t)}</svg>${esc(v.name)}<span class="tm-count">${D.places.filter((p) => (PTYPE[p.type] ? p.type : '') === t).length}</span></label>`).join('');
  $$('[data-type]').forEach((i) => i.addEventListener('change', () => { S.types[i.dataset.type] = i.checked; refreshPoints(); labels._draw(); }));
  $('#tm-track-types').innerHTML = Object.entries(TRACK).map(([t, v]) => `<label class="tm-check sm"><input type="checkbox" data-ttype="${t}" checked><svg class="tm-glyph" viewBox="0 0 16 16" aria-hidden="true"><line x1="1" y1="8" x2="15" y2="8" stroke="${v.color}" stroke-width="${v.weight + 0.6}" ${v.dash ? `stroke-dasharray="${v.dash}"` : ''}/></svg>${esc(v.name)}<span class="tm-count">${D.tracks.filter((x) => x.type === t).length}</span></label>`).join('');
  $$('[data-ttype]').forEach((i) => i.addEventListener('change', () => { S.trackTypes[i.dataset.ttype] = i.checked; refreshTracks(); }));
  function glyph(shape, t) {
    const f = '#f2ede4', s = '#0b0b0b';
    if (t === 'anchorage') return `<circle cx="8" cy="8" r="4" fill="rgba(0,0,0,.35)" stroke="#b9d6e6" stroke-width="1.6"/>`;
    if (t === '') return `<circle cx="8" cy="8" r="3.5" fill="#bdb6aa" stroke="${s}"/>`;
    if (shape === 'diamond') return `<path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" fill="${f}" stroke="${s}" stroke-width="1.2"/>`;
    if (shape === 'square') return `<rect x="4" y="4" width="8" height="8" fill="${f}" stroke="${s}" stroke-width="1.2"/>`;
    return `<circle cx="8" cy="8" r="4.2" fill="${f}" stroke="${s}" stroke-width="1.2"/>`;
  }
  function renderLegend() {
    const lg = D.legend, parts = [];
    if (S.on.places || S.on.landmarks) {
      parts.push(`<div class="tm-lg-sec"><h4>Markers</h4><ul class="tm-key">
        ${S.on.places ? `<li><svg class="tm-glyph" viewBox="0 0 16 16"><path d="M8 2 14 8 8 14 2 8Z" fill="#d12229" stroke="#0b0b0b" stroke-width="1.2"/></svg>Hapū seat (red fill)</li>
        <li><svg class="tm-glyph" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.6" fill="#f2ede4" stroke="#e5c48a" stroke-width="1.6" stroke-dasharray="2.5 2"/></svg>Dashed amber edge: 1810 holder unconfirmed</li>
        <li><svg class="tm-glyph" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.6" fill="rgba(242,237,228,.6)" stroke="#0b0b0b" stroke-width="1.2"/></svg>Faded: approximate location</li>` : ''}
        ${S.on.landmarks ? `<li><svg class="tm-glyph" viewBox="0 0 16 16"><path d="M8 2.5 13.2 12 2.8 12Z" fill="#e5c48a" stroke="#0b0b0b" stroke-width="1.1"/></svg>Landmark</li>
        <li><svg class="tm-glyph" viewBox="0 0 16 16"><path d="M8 2.5 13.2 12 2.8 12Z" fill="#e5c48a" stroke="#ff5a5f" stroke-width="2"/></svg>Red edge: consult mana whenua before modelling</li>` : ''}
      </ul></div>`);
    }
    if (S.on.territory) {
      const confs = [...new Set(G.map((g) => g.conf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'mi'));
      parts.push(`<div class="tm-lg-sec"><h4>Territory, coloured by ${S.colour === 'conf' ? 'confederation' : S.colour === 'iwi' ? 'iwi (shades of the confederation)' : 'hapū (shades of the confederation)'}</h4>
        <ul class="tm-swatches">${confs.map((c) => `<li><span style="background:${groupColour({ conf: c }, 'conf')}"></span>${esc(c)}</li>`).join('')}</ul>
        <ul class="tm-key"><li><svg class="tm-glyph" viewBox="0 0 16 16"><line x1="1" y1="8" x2="15" y2="8" stroke="#f4efe6" stroke-width="1.8"/></svg>Confederation border</li>
        <li><svg class="tm-glyph" viewBox="0 0 16 16"><line x1="1" y1="8" x2="15" y2="8" stroke="#f4efe6" stroke-opacity=".6" stroke-width="1"/></svg>Iwi border</li>
        <li><svg class="tm-glyph" viewBox="0 0 16 16"><line x1="1" y1="8" x2="15" y2="8" stroke="#f4efe6" stroke-opacity=".5" stroke-dasharray="2 3"/></svg>Hapū border</li></ul></div>`);
    }
    if (S.on.whenua) {
      const groups = {};
      for (const k of lg.kits) { if (!lg.kitKm2[k.id]) continue; (groups[k.group] = groups[k.group] || []).push(k); }
      const looks = [[2, 'Fern (bracken), cleared and kept open by fire', 12], [4, 'Mānuka and kānuka scrub', 11], [5, 'Forest and scrub mosaic', 10]];
      const lookCol = (id) => (lg.kits.find((k) => k.id === id) || {}).color;
      parts.push(`<div class="tm-lg-sec"><h4>Whenua: plant cover, c.1810</h4>
        <ul class="tm-swatches tm-wide">
          <li><span style="background:${lg.garden}"></span>Gardens <i>${(lg.stateKm2[3] || 0).toLocaleString('en-NZ')} km²</i></li>
          ${looks.map(([s, n, k]) => `<li><span style="background:${lookCol(k)}"></span>${n} <i>${(lg.stateKm2[s] || 0).toLocaleString('en-NZ')} km²</i></li>`).join('')}
        </ul>
        ${Object.entries(groups).map(([g, ks]) => `<details><summary>${esc(g)}</summary><ul class="tm-swatches tm-wide">${ks.map((k) => `<li title="${esc(k.note)}"><span style="background:${k.color}"></span>${esc(k.name)} <i>${lg.kitKm2[k.id].toLocaleString('en-NZ')} km²</i></li>`).join('')}</ul></details>`).join('')}
        <p class="tm-fine">Cleared forest keeps its forest kit underneath and is tinted with the look it has now. Areas are counted on the game map.</p></div>`);
    }
    if (S.on.tracks) parts.push(`<p class="tm-fine">Most tracks are modelled from terrain and sources and are still to be checked.</p>`);
    $('#tm-legend').innerHTML = parts.join('');
  }
  $('#tm-layers-toggle').addEventListener('click', () => {
    const open = layersBox.classList.toggle('is-open');
    $('#tm-layers-toggle').setAttribute('aria-expanded', open);
  });
  if (!EMBED && window.innerWidth >= 980) { layersBox.classList.add('is-open'); $('#tm-layers-toggle').setAttribute('aria-expanded', 'true'); }

  // ── controls ──────────────────────────────────────────────
  const landBounds = L.latLngBounds(D.places.map((p) => p.ll)).pad(0.04);
  $('#tm-zoom-in').addEventListener('click', () => map.zoomIn());
  $('#tm-zoom-out').addEventListener('click', () => map.zoomOut());
  $('#tm-home').addEventListener('click', () => map.flyToBounds(landBounds, { duration: 0.6 }));
  function share(btn) {
    const u = new URL(location.href);
    u.searchParams.delete('embed');
    navigator.clipboard?.writeText(u.toString()).then(() => { const t = btn.textContent; btn.textContent = 'Link copied'; setTimeout(() => { btn.textContent = t; }, 1600); }, () => prompt('Copy this link', u.toString()));
  }
  $('#tm-share').addEventListener('click', (e) => share(e.currentTarget));
  function toggleAbout(open) { $('#tm-about').hidden = !open; if (open) $('#tm-about-close').focus(); }
  $$('[data-about]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); toggleAbout(true); }));
  $('#tm-about-close').addEventListener('click', () => toggleAbout(false));
  $('#tm-about').addEventListener('click', (e) => { if (e.target.id === 'tm-about') toggleAbout(false); });

  // embed: wheel zoom only after the reader clicks into the map
  if (EMBED) {
    const full = new URL(location.href); full.searchParams.delete('embed');
    $('#tm-open-full').href = full.toString();
    map.once('click', () => map.scrollWheelZoom.enable());
    $('#map').addEventListener('wheel', () => { if (!map.scrollWheelZoom.enabled()) { const h = $('#tm-wheel-hint'); h.hidden = false; clearTimeout(h._t); h._t = setTimeout(() => { h.hidden = true; }, 1400); } }, { passive: true });
  }

  // ── URL state ─────────────────────────────────────────────
  let urlTimer = null;
  function syncURL() {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      const u = new URL(location.href), c = map.getCenter();
      const w = fromLL(c);
      u.searchParams.set('v', `${w[0].toFixed(4)},${w[1].toFixed(4)},${map.getZoom()}`);
      u.searchParams.set('l', Object.entries(LAYER_CODES).filter(([k]) => S.on[k]).map(([, v]) => v).join(''));
      if (S.colour !== 'conf') u.searchParams.set('c', S.colour); else u.searchParams.delete('c');
      u.searchParams.delete('p'); u.searchParams.delete('g'); u.searchParams.delete('m');
      if (S.sel?.kind === 'place') u.searchParams.set('p', S.sel.id);
      if (S.sel?.kind === 'landmark') u.searchParams.set('m', S.sel.id);
      if (S.sel?.kind === 'group') u.searchParams.set('g', G[S.sel.id].hapu + '|' + G[S.sel.id].iwi);
      history.replaceState(null, '', u);
      if (EMBED) { const f = new URL(u); f.searchParams.delete('embed'); $('#tm-open-full').href = f.toString(); }
    }, 250);
  }
  map.on('moveend', syncURL);
  map.on('zoomend', () => { refreshPoints(); });
  map.on('click', (e) => {
    if (Date.now() - lastHit < 400) return;
    const gi = S.on.territory ? groupAt(e.latlng) : -1;
    if (gi >= 0) select({ kind: 'group', id: gi });
    else if (S.sel) closePanel();
  });
  // hover name for territories (pointer devices)
  const tip = $('#tm-hover');
  let tipRaf = 0;
  map.on('mousemove', (e) => {
    if (!S.on.territory || tipRaf) return;
    tipRaf = requestAnimationFrame(() => {
      tipRaf = 0;
      const gi = groupAt(e.latlng);
      if (gi < 0) { tip.hidden = true; return; }
      const g = G[gi];
      tip.innerHTML = `<b>${esc(g.hapu || g.iwi)}</b>${g.hapu && g.iwi ? `<span>${esc(g.iwi)}</span>` : ''}`;
      tip.style.transform = `translate(${e.containerPoint.x + 14}px, ${e.containerPoint.y + 12}px)`;
      tip.hidden = false;
    });
  });
  map.on('mouseout movestart', () => { tip.hidden = true; });

  // ── start ─────────────────────────────────────────────────
  const v = (params.get('v') || '').split(',').map(Number);
  if (v.length === 3 && v.every(Number.isFinite)) map.setView(toLL([v[0], v[1]]), v[2]);
  else map.fitBounds(landBounds);
  labels.addTo(map);
  applyLayers();
  const startP = params.get('p'), startM = params.get('m'), startG = params.get('g');
  if (startP && PL.has(startP)) { select({ kind: 'place', id: startP }); if (!(v.length === 3)) map.setView(PL.get(startP)._p.ll, 5); }
  else if (startM && LM.has(startM)) { select({ kind: 'landmark', id: startM }); if (!(v.length === 3)) map.setView(LM.get(startM)._l.ll, 5); }
  else if (startG) { const [h, i] = startG.split('|'); const gi = G.findIndex((g) => g.hapu === h && g.iwi === i); if (gi >= 0) { select({ kind: 'group', id: gi }); if (!(v.length === 3)) flyToGroup(gi); } }
  $('#tm-stamp').textContent = new Date(M.exported).toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });
  $('#tm-counts').textContent = `${D.places.length.toLocaleString('en-NZ')} places, ${G.length} hapū territories, ${D.landmarks.length} landmarks, ${D.tracks.length} tracks`;
  document.documentElement.classList.add('is-ready');
})();
