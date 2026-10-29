// Turns a Google Docs API document (fetched with includeTabsContent=true) into
// posts made of simple blocks, then renders those blocks to clean HTML.
// No Google styling survives: only headings, paragraphs, bold, italics,
// links, lists, tables, images with captions, quotes and footnotes.
import { clean, esc, slugify, sameText } from './util.mjs';
import { readDetailsRows } from './meta.mjs';

const HEADING_LEVEL = { HEADING_1: 2, HEADING_2: 3, HEADING_3: 4, HEADING_4: 5, HEADING_5: 6, HEADING_6: 6 };
const ORDERED = new Set(['DECIMAL', 'ZERO_DECIMAL', 'ALPHA', 'UPPER_ALPHA', 'ROMAN', 'UPPER_ROMAN']);
const MONO = /mono|courier|consolas|menlo|inconsolata|source code|fira code/i;
const OPEN_QUOTE = /^["“‘'«„]/;
const CREDIT_START = /(^|\s)(Photo|Photograph|Image|Credit|Credits|Source|Courtesy|Picture)s?\s*:/;

// ───────────────────────── plain text helpers ─────────────────────────

function paragraphText(p) {
  let s = '';
  for (const e of p.elements || []) {
    if (e.textRun) s += e.textRun.content;
    else if (e.dateElement) s += e.dateElement.dateElementProperties?.displayText || e.dateElement.dateElementProperties?.timestamp || '';
    else if (e.richLink) s += e.richLink.richLinkProperties?.title || e.richLink.richLinkProperties?.uri || '';
    else if (e.person) s += e.person.personProperties?.name || e.person.personProperties?.email || '';
  }
  return clean(s).replace(/[\n\u000b]+/g, ' ');
}

export function elementsText(content = []) {
  const parts = [];
  for (const el of content) {
    if (el.paragraph) parts.push(paragraphText(el.paragraph));
    else if (el.table) for (const r of el.table.tableRows || []) for (const c of r.tableCells || []) parts.push(elementsText(c.content));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const isBlankParagraph = (el) => el.paragraph && !paragraphText(el.paragraph).trim() &&
  !(el.paragraph.elements || []).some((e) => e.inlineObjectElement || e.horizontalRule) &&
  !(el.paragraph.positionedObjectIds || []).length;

// ───────────────────────── tabs and posts ─────────────────────────

function allTabs(doc) {
  if (Array.isArray(doc.tabs) && doc.tabs.length) return doc.tabs;
  // Docs fetched without tabs content: treat the whole body as one tab.
  return [{ tabProperties: { tabId: 't.0', title: doc.title }, documentTab: { body: doc.body, lists: doc.lists, inlineObjects: doc.inlineObjects, positionedObjects: doc.positionedObjects, footnotes: doc.footnotes } }];
}

function findDetails(documentTab) {
  const content = documentTab?.body?.content || [];
  let seen = 0;
  for (let i = 0; i < content.length && seen < 6; i++) {
    const el = content[i];
    if (el.sectionBreak || isBlankParagraph(el)) continue;
    seen++;
    if (!el.table) continue;
    const rows = (el.table.tableRows || []).map((r) => (r.tableCells || []).map((c) => elementsText(c.content)));
    const details = readDetailsRows(rows);
    if (details) return { index: i, ...details };
  }
  return null;
}

/**
 * Rule: a tab whose top has a details table is a post. Child tabs without a
 * table fold into that post as sections (unless their name starts with "_").
 * Child tabs with their own table are posts of their own. Every other tab is
 * ignored, so notes and unfinished tabs stay private.
 */
export function extractPosts(doc) {
  const posts = [];
  const ignored = [];

  function walk(tab, parentPost, depth) {
    const props = tab.tabProperties || {};
    const title = clean(props.title || 'Untitled').trim();
    const hidden = title.startsWith('_');
    const details = hidden ? null : findDetails(tab.documentTab);
    let post = parentPost;
    if (details) {
      post = {
        docId: doc.documentId,
        docTitle: clean(doc.title || ''),
        tabId: props.tabId,
        key: `${doc.documentId}:${props.tabId}`,
        tabTitle: title,
        fields: details.fields,
        unknownFields: details.unknown,
        state: newPostState(),
        sections: [],
        tabIds: [props.tabId],
        warnings: [],
      };
      posts.push(post);
      post.sections.push(convertTab(tab, post, { skipIndex: details.index, depth: 0, title: null }));
    } else if (parentPost && !hidden) {
      parentPost.tabIds.push(props.tabId);
      parentPost.sections.push(convertTab(tab, parentPost, { skipIndex: -1, depth: depth, title }));
    } else {
      ignored.push(title);
    }
    const myDepth = details ? 0 : depth;
    for (const child of tab.childTabs || []) walk(child, hidden ? null : post, post ? myDepth + 1 : 0);
  }

  for (const tab of allTabs(doc)) walk(tab, null, 0);
  return { posts, ignored };
}

function newPostState() {
  return { usedIds: new Set(), headings: new Map(), footnotes: [], listCounters: new Map(), sectionAnchors: new Map(), titleText: null, subtitleText: null };
}

function uniqueId(state, text) {
  const base = slugify(text);
  let id = base;
  let n = 2;
  while (state.usedIds.has(id)) id = `${base}-${n++}`;
  state.usedIds.add(id);
  return id;
}

function convertTab(tab, post, { skipIndex, depth, title }) {
  const dt = tab.documentTab || {};
  const ctx = {
    post,
    tabId: tab.tabProperties?.tabId,
    lists: dt.lists || {},
    inlineObjects: dt.inlineObjects || {},
    positionedObjects: dt.positionedObjects || {},
    footnotes: dt.footnotes || {},
    shift: depth, // folded child tabs push their headings down a level
  };
  const content = (dt.body?.content || []).filter((_, i) => i !== skipIndex);
  let blocks = convertElements(content, ctx);
  if (title) {
    // A folded child tab opens with its own name as a heading.
    const anchor = uniqueId(post.state, title);
    post.state.sectionAnchors.set(ctx.tabId, anchor);
    blocks.unshift({ type: 'h', level: Math.min(6, 1 + depth), segments: [{ text: title }], text: title, anchor });
  }
  blocks = postProcess(blocks, ctx);
  return { tabId: ctx.tabId, title, blocks };
}

// ───────────────────────── elements → blocks ─────────────────────────

function convertElements(content, ctx) {
  const blocks = [];
  for (const el of content) {
    if (el.paragraph) blocks.push(...convertParagraph(el.paragraph, ctx));
    else if (el.table) blocks.push(convertTable(el.table, ctx));
    // sectionBreak and tableOfContents are dropped.
  }
  return blocks;
}

function embeddedImage(obj, key, ctx, kind) {
  const eo = obj?.[kind]?.embeddedObject;
  if (!eo) return null;
  const uri = eo.imageProperties?.contentUri;
  if (!uri) {
    ctx.post.warnings.push(`A drawing or chart in "${ctx.post.tabTitle}" can't be exported by Google. Paste it in as an image instead.`);
    return null;
  }
  return {
    key: `${ctx.tabId}:${key}`,
    contentUri: uri,
    alt: clean(eo.description || eo.title || '').trim(),
  };
}

function linkOf(ts, ctx) {
  const l = ts?.link;
  if (!l) return null;
  if (l.url) return { kind: 'url', url: l.url };
  if (l.heading || l.headingId) return { kind: 'heading', tabId: l.heading?.tabId || l.tabId || ctx.tabId, id: l.heading?.id || l.headingId };
  if (l.tabId) return { kind: 'tab', tabId: l.tabId };
  return null; // bookmarks have no web equivalent
}

function runSegments(content, ts, ctx) {
  const style = {
    b: !!ts?.bold,
    i: !!ts?.italic,
    s: !!ts?.strikethrough,
    sup: ts?.baselineOffset === 'SUPERSCRIPT',
    sub: ts?.baselineOffset === 'SUBSCRIPT',
    code: MONO.test(ts?.weightedFontFamily?.fontFamily || ''),
    link: linkOf(ts, ctx),
  };
  const out = [];
  const text = clean(content).replace(/\r/g, '').replace(/\n$/, '').replace(/\f/g, '');
  for (const part of text.split(/(\u000b|\n)/)) {
    if (part === '\u000b' || part === '\n') out.push({ br: true });
    else if (part) out.push({ text: part, ...style });
  }
  return out;
}

function convertParagraph(p, ctx) {
  const style = p.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
  const out = [];
  const images = [];
  const segments = [];
  let hr = false;

  for (const id of p.positionedObjectIds || []) {
    const img = embeddedImage(ctx.positionedObjects[id], id, ctx, 'positionedObjectProperties');
    if (img) out.push({ type: 'figure', images: [img] });
  }

  for (const e of p.elements || []) {
    if (e.textRun) segments.push(...runSegments(e.textRun.content, e.textRun.textStyle, ctx));
    else if (e.inlineObjectElement) {
      const id = e.inlineObjectElement.inlineObjectId;
      const img = embeddedImage(ctx.inlineObjects[id], id, ctx, 'inlineObjectProperties');
      if (img) images.push(img);
    } else if (e.footnoteReference) {
      const fnId = e.footnoteReference.footnoteId;
      const n = ctx.post.state.footnotes.length + 1;
      const fn = ctx.footnotes[fnId];
      const blocks = fn ? postProcess(convertElements(fn.content || [], { ...ctx, footnotes: {} }), ctx) : [];
      ctx.post.state.footnotes.push({ n, blocks });
      segments.push({ fn: n });
    } else if (e.person) {
      const pp = e.person.personProperties || {};
      segments.push({ text: clean(pp.name || pp.email || ''), ...(e.person.textStyle?.bold ? { b: true } : {}) });
    } else if (e.richLink) {
      const rp = e.richLink.richLinkProperties || {};
      segments.push({ text: clean(rp.title || rp.uri || ''), link: rp.uri ? { kind: 'url', url: rp.uri } : null });
    } else if (e.dateElement) {
      const dp = e.dateElement.dateElementProperties || {};
      segments.push({ text: clean(dp.displayText || (dp.timestamp || '').slice(0, 10)) });
    } else if (e.horizontalRule) hr = true;
    else if (e.equation) ctx.post.warnings.push(`An equation in "${ctx.post.tabTitle}" was skipped. Type it as text instead.`);
  }

  if (images.length) out.push({ type: 'figure', images });
  const text = segments.map((s) => s.text || (s.br ? ' ' : '')).join('').replace(/\s+/g, ' ').trim();
  if (hr && !text) out.push({ type: 'hr' });
  if (!text && !segments.some((s) => s.fn)) return out;

  if (style === 'TITLE') { ctx.post.state.titleText ??= text; return out; }
  if (style === 'SUBTITLE') { ctx.post.state.subtitleText ??= text; return out; }

  if (HEADING_LEVEL[style]) {
    const level = Math.min(6, HEADING_LEVEL[style] + ctx.shift);
    const anchor = uniqueId(ctx.post.state, text);
    if (p.paragraphStyle.headingId) ctx.post.state.headings.set(`${ctx.tabId}|${p.paragraphStyle.headingId}`, anchor);
    // Headings are bold by default in many Doc styles; that's not emphasis.
    out.push({ type: 'h', level, segments: segments.map((s) => ({ ...s, b: false })), text, anchor });
    return out;
  }

  if (p.bullet) {
    const level = p.bullet.nestingLevel || 0;
    const glyph = ctx.lists[p.bullet.listId]?.listProperties?.nestingLevels?.[level]?.glyphType;
    out.push({ type: 'li', listId: p.bullet.listId, level, ordered: ORDERED.has(glyph), segments, text });
    return out;
  }

  const visible = segments.filter((s) => s.text && s.text.trim());
  out.push({ type: 'p', segments, text, italic: visible.length > 0 && visible.every((s) => s.i) });
  return out;
}

function convertTable(table, ctx) {
  const columns = table.columns || Math.max(...(table.tableRows || []).map((r) => (r.tableCells || []).length));
  const covered = new Set();
  const rows = (table.tableRows || []).map((row, ri) => {
    const cellsIn = row.tableCells || [];
    const complete = cellsIn.length === columns; // merged cells still listed?
    const cells = [];
    cellsIn.forEach((cell, ci) => {
      if (complete && covered.has(`${ri}:${ci}`)) return;
      const cs = cell.tableCellStyle || {};
      const colspan = cs.columnSpan > 1 ? cs.columnSpan : 1;
      const rowspan = cs.rowSpan > 1 ? cs.rowSpan : 1;
      for (let r = 0; r < rowspan; r++) for (let c = 0; c < colspan; c++) if (r || c) covered.add(`${ri + r}:${ci + c}`);
      const blocks = postProcess(convertElements(cell.content || [], ctx), ctx);
      const segs = blocks.flatMap((b) => b.segments || []).filter((s) => s.text && s.text.trim());
      cells.push({ blocks, colspan, rowspan, allBold: segs.length > 0 && segs.every((s) => s.b) });
    });
    return { header: !!row.tableRowStyle?.tableHeader, cells };
  });
  return { type: 'table', rows };
}

// ───────────────────────── block clean-up ─────────────────────────

function splitSegmentsAt(segments, offset) {
  const a = [];
  const b = [];
  let pos = 0;
  for (const s of segments) {
    const len = s.text ? s.text.length : s.br ? 1 : 0;
    if (pos + len <= offset) a.push(s);
    else if (pos >= offset) b.push(s);
    else {
      const cut = offset - pos;
      a.push({ ...s, text: s.text.slice(0, cut) });
      b.push({ ...s, text: s.text.slice(cut) });
    }
    pos += len;
  }
  return [a, b];
}

function captionParts(segments) {
  const brAt = segments.findIndex((s) => s.br);
  if (brAt > -1) return [segments.slice(0, brAt), segments.slice(brAt + 1)];
  const flat = segments.map((s) => s.text || (s.br ? '\n' : '')).join('');
  const m = flat.match(CREDIT_START);
  if (m && m.index > 0) return splitSegmentsAt(segments, m.index + m[1].length);
  return [segments, []];
}

const VIDEO = [
  { re: /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/, provider: 'youtube' },
  { re: /vimeo\.com\/(?:video\/)?(\d+)/, provider: 'vimeo' },
];

function postProcess(blocks, ctx) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const next = blocks[i + 1];

    // Image followed by an italic paragraph: that paragraph is its caption.
    if (b.type === 'figure' && next?.type === 'p' && next.italic && next.text.length <= 600) {
      const [cap, credit] = captionParts(next.segments);
      out.push({ ...b, caption: cap, credit });
      i++;
      continue;
    }

    // A quote followed by a single bullet is an epigraph with its attribution.
    if (b.type === 'p' && OPEN_QUOTE.test(b.text) && next?.type === 'li' && next.level === 0 && !next.ordered &&
        !(blocks[i + 2]?.type === 'li' && blocks[i + 2].listId === next.listId)) {
      out.push({ type: 'epigraph', quote: b.segments, cite: next.segments });
      i++;
      continue;
    }

    // A paragraph that is only a YouTube or Vimeo link becomes a player.
    if (b.type === 'p') {
      const linked = b.segments.filter((s) => s.text && s.text.trim());
      const url = linked[0]?.link?.kind === 'url' ? linked[0].link.url : /^https?:\/\/\S+$/.test(b.text) ? b.text : null;
      if (url && linked.every((s) => (s.link?.url || url) === url)) {
        const v = VIDEO.map((x) => ({ ...x, m: url.match(x.re) })).find((x) => x.m);
        if (v) { out.push({ type: 'embed', provider: v.provider, id: v.m[1], url, title: b.text === url ? 'Video' : b.text }); continue; }
      }
    }

    out.push(b);
  }
  return groupLists(out, ctx);
}

function groupLists(blocks, ctx) {
  const out = [];
  let stack = [];
  const counters = ctx.post.state.listCounters;
  for (const b of blocks) {
    if (b.type !== 'li') { stack = []; out.push(b); continue; }
    while (stack.length && stack.at(-1).level > b.level) stack.pop();
    let top = stack.at(-1);
    if (top && top.level === b.level && top.list.listId !== b.listId) { stack.pop(); top = stack.at(-1); }
    if (!top || top.level < b.level) {
      const ck = `${b.listId}|${b.level}`;
      const list = { type: 'list', ordered: b.ordered, listId: b.listId, start: (counters.get(ck) || 0) + 1, items: [] };
      if (!top) out.push(list);
      else {
        if (!top.list.items.length) top.list.items.push({ segments: [], children: [] });
        top.list.items.at(-1).children.push(list);
      }
      stack.push({ level: b.level, list });
      top = stack.at(-1);
    }
    top.list.items.push({ segments: b.segments, children: [] });
    const ck = `${b.listId}|${b.level}`;
    counters.set(ck, (counters.get(ck) || 0) + 1);
    for (const k of [...counters.keys()]) {
      const [id, lvl] = k.split('|');
      if (id === b.listId && +lvl > b.level) counters.delete(k);
    }
  }
  return out;
}

/** Drops a leading heading that only repeats the post title. */
export function dropTitleHeading(post, title) {
  const blocks = post.sections[0]?.blocks;
  if (!blocks) return;
  const at = blocks.findIndex((b) => b.type !== 'epigraph' && b.type !== 'figure' && b.type !== 'hr');
  if (at > -1 && blocks[at].type === 'h' && sameText(blocks[at].text, title)) blocks.splice(at, 1);
}

export function firstParagraph(post) {
  for (const s of post.sections) for (const b of s.blocks) if (b.type === 'p' && b.text.length > 40) return b.text;
  for (const s of post.sections) for (const b of s.blocks) if (b.type === 'p') return b.text;
  return '';
}

export function collectImages(post) {
  const list = [];
  const walk = (blocks) => {
    for (const b of blocks) {
      if (b.type === 'figure') list.push(...b.images);
      if (b.type === 'table') for (const r of b.rows) for (const c of r.cells) walk(c.blocks);
    }
  };
  for (const s of post.sections) walk(s.blocks);
  return list;
}

// ───────────────────────── rendering ─────────────────────────

function tagsFor(s, opts, resolve) {
  const t = [];
  const href = s.link ? resolve(s.link) : null;
  if (href) t.push({ key: `a|${href}`, open: `<a href="${esc(href)}">`, close: '</a>' });
  if (s.b && !opts.noBold) t.push({ key: 'b', open: '<strong>', close: '</strong>' });
  if (s.i && !opts.noItalic) t.push({ key: 'i', open: '<em>', close: '</em>' });
  if (s.s) t.push({ key: 's', open: '<s>', close: '</s>' });
  if (s.sup) t.push({ key: 'sup', open: '<sup>', close: '</sup>' });
  if (s.sub) t.push({ key: 'sub', open: '<sub>', close: '</sub>' });
  if (s.code) t.push({ key: 'code', open: '<code>', close: '</code>' });
  return t;
}

function commonPrefix(a = [], b = []) {
  const out = [];
  for (let i = 0; i < Math.min(a.length, b.length) && a[i].key === b[i].key; i++) out.push(a[i]);
  return out;
}

export function renderInline(segments, resolve, opts = {}) {
  // 1. Tokens, with whitespace split off so it never sits inside <strong>.
  const tokens = [];
  for (const s of segments || []) {
    if (s.br) tokens.push({ html: '<br>', flex: true });
    else if (s.fn) tokens.push({ html: `<sup class="fn-ref" id="fnref-${s.fn}"><a href="#fn-${s.fn}" aria-label="Footnote ${s.fn}">${s.fn}</a></sup>`, flex: true });
    else if (s.text) {
      const m = s.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const tags = tagsFor(s, opts, resolve);
      if (m[1]) tokens.push({ html: esc(m[1]), flex: true, link: tags[0]?.key.startsWith('a|') ? tags[0] : null });
      if (m[2]) tokens.push({ html: esc(m[2]), tags });
      if (m[3]) tokens.push({ html: esc(m[3]), flex: true, link: tags[0]?.key.startsWith('a|') ? tags[0] : null });
    }
  }
  // 2. Whitespace and breaks take whatever formatting both neighbours share.
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].flex) continue;
    let p = i - 1; while (p >= 0 && tokens[p].flex) p--;
    let n = i + 1; while (n < tokens.length && tokens[n].flex) n++;
    tokens[i].tags = commonPrefix(tokens[p]?.tags, tokens[n]?.tags);
  }
  // 3. Open and close tags with a stack so nesting is always valid.
  let html = '';
  let stack = [];
  for (const t of tokens) {
    const keep = commonPrefix(stack, t.tags);
    for (let i = stack.length - 1; i >= keep.length; i--) html += stack[i].close;
    for (let i = keep.length; i < t.tags.length; i++) html += t.tags[i].open;
    stack = t.tags;
    html += t.html;
  }
  for (let i = stack.length - 1; i >= 0; i--) html += stack[i].close;
  return html.replace(/^(?:\s|<br>)+|(?:\s|<br>)+$/g, '');
}

function renderImage(img, env) {
  const r = env.images.get(img.key);
  if (!r) return '';
  const alt = esc(img.alt || env.fallbackAlt || '');
  const eager = env.eagerKey === img.key;
  const lazy = eager ? 'fetchpriority="high"' : 'loading="lazy"';
  const sizes = env.gallery ? '(min-width: 1100px) 500px, 50vw' : '(min-width: 1100px) 1040px, 100vw';
  if (r.animated) return `<img src="${r.src}" alt="${alt}" width="${r.width}" height="${r.height}" ${lazy} decoding="async">`;
  return `<picture><source type="image/avif" srcset="${r.avif}" sizes="${sizes}"><source type="image/webp" srcset="${r.webp}" sizes="${sizes}"><img src="${r.src}" alt="${alt}" width="${r.width}" height="${r.height}" ${lazy} decoding="async"></picture>`;
}

function renderList(list, resolve) {
  const tag = list.ordered ? 'ol' : 'ul';
  const start = list.ordered && list.start > 1 ? ` start="${list.start}"` : '';
  const items = list.items.map((it) => `<li>${renderInline(it.segments, resolve)}${it.children.map((c) => renderList(c, resolve)).join('')}</li>`).join('');
  return `<${tag}${start}>${items}</${tag}>`;
}

function renderCell(cell, env) {
  if (cell.blocks.length === 1 && cell.blocks[0].type === 'p') return renderInline(cell.blocks[0].segments, env.resolve);
  return renderBlocks(cell.blocks, env);
}

function renderTable(t, env) {
  if (!t.rows.length) return '';
  const headed = t.rows.length > 1 && (t.rows[0].header || t.rows[0].cells.every((c) => c.allBold));
  const span = (c) => (c.colspan > 1 ? ` colspan="${c.colspan}"` : '') + (c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : '');
  let html = '<div class="table-wrap"><table>';
  let rows = t.rows;
  if (headed) {
    html += `<thead><tr>${rows[0].cells.map((c) => `<th scope="col"${span(c)}>${renderInline(c.blocks.flatMap((b) => b.segments || []), env.resolve, { noBold: true })}</th>`).join('')}</tr></thead>`;
    rows = rows.slice(1);
  }
  html += `<tbody>${rows.map((r) => `<tr>${r.cells.map((c) => `<td${span(c)}>${renderCell(c, env)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  return html + '</table></div>';
}

export function renderBlocks(blocks, env) {
  const { resolve } = env;
  return blocks.map((b) => {
    switch (b.type) {
      case 'p': return `<p>${renderInline(b.segments, resolve)}</p>`;
      case 'h': return `<h${b.level} id="${b.anchor}">${renderInline(b.segments, resolve, { noBold: true })}</h${b.level}>`;
      case 'hr': return '<hr>';
      case 'list': return renderList(b, resolve);
      case 'table': return renderTable(b, env);
      case 'epigraph':
        return `<figure class="epigraph"><blockquote><p>${renderInline(b.quote, resolve)}</p></blockquote><figcaption>${renderInline(b.cite, resolve)}</figcaption></figure>`;
      case 'embed': {
        const src = b.provider === 'youtube'
          ? `https://www.youtube-nocookie.com/embed/${b.id}`
          : `https://player.vimeo.com/video/${b.id}?dnt=1`;
        return `<figure class="embed"><div class="embed-frame"><iframe src="${src}" title="${esc(b.title)}" loading="lazy" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div><figcaption><a href="${esc(b.url)}">${esc(b.title === 'Video' ? 'Watch the video' : b.title)}</a></figcaption></figure>`;
      }
      case 'figure': {
        const capText = (b.caption || []).map((s) => s.text || '').join('').trim();
        const gallery = b.images.length > 1;
        const imgs = b.images.map((img) => renderImage(img, { ...env, gallery, fallbackAlt: capText })).filter(Boolean);
        if (!imgs.length) return '';
        const cap = b.caption?.length ? `<span class="caption">${renderInline(b.caption, resolve, { noItalic: true })}</span>` : '';
        const credit = b.credit?.length ? `<span class="credit">${renderInline(b.credit, resolve, { noItalic: true })}</span>` : '';
        const fc = cap || credit ? `<figcaption>${cap}${credit}</figcaption>` : '';
        const media = gallery ? `<div class="gallery gallery--${Math.min(imgs.length, 3)}">${imgs.join('')}</div>` : imgs[0];
        return `<figure class="figure${gallery ? ' figure--gallery' : ''}">${media}${fc}</figure>`;
      }
      default: return '';
    }
  }).filter(Boolean).join('\n');
}

export function renderPost(post, env) {
  let html = post.sections.map((s) => renderBlocks(s.blocks, env)).join('\n');
  const notes = post.state.footnotes;
  if (notes.length) {
    const items = notes.map((f) => {
      let body = f.blocks.length === 1 && f.blocks[0].type === 'p' ? renderInline(f.blocks[0].segments, env.resolve) : renderBlocks(f.blocks, env);
      return `<li id="fn-${f.n}">${body} <a href="#fnref-${f.n}" class="fn-back" aria-label="Back to text">↩</a></li>`;
    }).join('');
    html += `\n<section class="footnotes" aria-label="Notes"><h2 class="footnotes-title" id="notes">Notes</h2><ol>${items}</ol></section>`;
  }
  return html;
}
