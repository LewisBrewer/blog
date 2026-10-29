#!/usr/bin/env node
// The publishing job. Reads every Doc in the Drive folder, turns tabs with a
// details table into posts, writes them into src/posts and src/media, takes
// down posts that have gone, and reports what happened.
//
//   node converter/sync.mjs                 normal run (uses Google)
//   node converter/sync.mjs --preview       include drafts, don't save state
//   node converter/sync.mjs --force         re-convert everything
//   node converter/sync.mjs --allow-removals
//   node converter/sync.mjs --fixture test/fixtures/run1   offline test data
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './google.mjs';
import { extractPosts, dropTitleHeading, firstParagraph, collectImages, renderPost } from './docs-to-html.mjs';
import { parseDate, parseTags, parseStatus, parseCover } from './meta.mjs';
import { download, processImage, makeOgImage } from './images.mjs';
import { slugify, sha, todayIn, truncate, wordCount, nfc } from './util.mjs';
import { writeSummary, openOrUpdateIssue } from './github.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONVERTER_VERSION = 1; // bump to re-convert every post after converter changes
const MAX_REMOVALS = 2;
const RESERVED = new Set(['tags', 'series', 'widget', 'assets', 'media', 'posts', 'feed', 'page', 'about', 'search', 'rss', 'sitemap', '404']);

const argv = process.argv.slice(2);
const flag = (name, env) => argv.includes(`--${name}`) || process.env[env] === 'true';
const opts = {
  preview: flag('preview', 'PREVIEW'),
  force: flag('force', 'FORCE'),
  allowRemovals: flag('allow-removals', 'ALLOW_REMOVALS'),
  fixture: argv.includes('--fixture') ? argv[argv.indexOf('--fixture') + 1] : null,
};

const P = {
  site: path.join(ROOT, 'src/_data/site.json'),
  state: path.join(ROOT, 'data/state.json'),
  redirects: path.join(ROOT, 'src/_data/redirects.json'),
  posts: path.join(ROOT, 'src/posts'),
  media: path.join(ROOT, 'src/media'),
};

const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
};

// ───────────────────────── where the Docs come from ─────────────────────────

async function openSource() {
  if (opts.fixture) {
    const dir = path.resolve(ROOT, opts.fixture);
    const folder = await readJson(path.join(dir, 'folder.json'), []);
    return {
      label: `fixture ${opts.fixture}`,
      list: async () => folder.map(({ file, ...d }) => d),
      getDoc: async (id) => JSON.parse(await fs.readFile(path.join(dir, folder.find((d) => d.id === id).file), 'utf8')),
      token: null,
    };
  }
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folderId = (process.env.DRIVE_FOLDER_ID || '').trim();
  if (!json || !folderId) return null;
  const g = await connect(json);
  return { label: `Drive folder as ${g.email}`, list: () => g.listFolder(folderId), getDoc: (id) => g.getDoc(id), token: () => g.token() };
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const site = await readJson(P.site, {});
  const source = await openSource();
  if (!source) {
    const msg = 'Google Drive is not connected yet (GOOGLE_SERVICE_ACCOUNT_JSON or DRIVE_FOLDER_ID is missing), so no posts were synced. The site was still built from what is already in the repo.';
    console.log(msg);
    await writeSummary(`### Blog sync skipped\n\n${msg}`);
    return;
  }

  const state = await readJson(P.state, { posts: {}, docs: {} });
  state.posts ||= {};
  state.docs ||= {};
  const today = todayIn(site.timezone || 'Australia/Melbourne');
  const force = opts.force || opts.preview || state.converterVersion !== CONVERTER_VERSION;

  const report = { added: [], updated: [], unchanged: [], removed: [], drafts: [], warnings: [], errors: [], ignoredTabs: [] };
  const seen = new Set();
  const keepPostsOfDoc = (docId) => { for (const [k, v] of Object.entries(state.posts)) if (v.docId === docId) seen.add(k); };

  console.log(`Reading ${source.label}`);
  let list = [];
  let listFailed = false;
  try {
    list = await source.list();
  } catch (e) {
    listFailed = true;
    report.errors.push(`Couldn't read the Drive folder: ${e.message}. Check the folder is shared with the service account and DRIVE_FOLDER_ID is right. Nothing was taken down.`);
  }
  if (!listFailed && !list.length && Object.keys(state.posts).length) {
    report.errors.push('The Drive folder looks empty, so nothing was taken down. If you really meant to remove every post, run the workflow with "Allow removals" ticked.');
  }

  // 1. Fetch the Docs that changed.
  const fetched = [];
  for (const d of list) {
    if (d.error) { report.errors.push(d.error); keepPostsOfDoc(d.id); continue; }
    const prev = state.docs[d.id];
    if (!force && prev && prev.modifiedTime === d.modifiedTime) { keepPostsOfDoc(d.id); continue; }
    try {
      const doc = await source.getDoc(d.id);
      const { posts, ignored } = extractPosts(doc);
      fetched.push({ d, posts });
      if (ignored.length) report.ignoredTabs.push(`${d.name}: ${ignored.join(', ')}`);
      if (!posts.length) report.warnings.push(`"${d.name}" has no tab with a details table, so it has no posts.`);
    } catch (e) {
      report.errors.push(`Couldn't read "${d.name}": ${e.message}. Its posts were left as they are.`);
      keepPostsOfDoc(d.id);
    }
  }

  // 2. Work out titles, dates, slugs.
  const takenSlugs = new Map(); // slug -> key
  const processingKeys = new Set(fetched.flatMap((f) => f.posts.map((p) => p.key)));
  for (const [k, v] of Object.entries(state.posts)) if (!processingKeys.has(k)) takenSlugs.set(v.slug, k);

  const items = [];
  for (const { d, posts } of fetched) {
    for (const p of posts) {
      const f = p.fields;
      const prev = state.posts[p.key];
      const status = parseStatus(f.status);
      const title = nfc(f.title || p.state.titleText || p.tabTitle).replace(/\s+/g, ' ').trim();
      if (status === 'draft' && !opts.preview) { report.drafts.push(title); continue; }
      seen.add(p.key);

      let slug = f.slug ? slugify(f.slug.split(/[/?#]/).filter(Boolean).pop() || f.slug) : prev?.slug || slugify(title);
      if (RESERVED.has(slug)) slug = `${slug}-post`;
      const base = slug;
      for (let n = 2; takenSlugs.has(slug) && takenSlugs.get(slug) !== p.key; n++) slug = `${base}-${n}`;
      takenSlugs.set(slug, p.key);

      let date = f.date ? parseDate(f.date) : null;
      if (f.date && !date) report.warnings.push(`"${title}": couldn't read the date "${f.date}". Write it like 30 October 2026.`);
      date ||= prev?.date || today;

      const seriesRaw = (f.series || '').trim();
      const series = /^(none|no|-)$/i.test(seriesRaw) ? null : seriesRaw || site.defaultSeries || null;
      const cover = parseCover(f.cover);
      if (cover.warning) report.warnings.push(`"${title}": ${cover.warning}`);
      for (const u of p.unknownFields) report.warnings.push(`"${title}": the details row "${u}" isn't a field the blog knows, so it was ignored.`);
      items.push({ p, d, prev, status, title, slug, date, tags: parseTags(f.tags || ''), series, cover, summaryField: f.summary });
    }
  }

  // 3. Maps so links between tabs and headings point at the right post.
  const tabMap = new Map();
  const headingMap = new Map();
  for (const v of Object.values(state.posts)) for (const t of v.tabIds || []) tabMap.set(`${v.docId}|${t}`, { url: `/${v.slug}/`, anchor: v.sections?.[t] || '' });
  for (const it of items) {
    for (const t of it.p.tabIds) tabMap.set(`${it.p.docId}|${t}`, { url: `/${it.slug}/`, anchor: it.p.state.sectionAnchors.get(t) || '' });
    for (const [k, anchor] of it.p.state.headings) headingMap.set(`${it.p.docId}|${k}`, { url: `/${it.slug}/`, anchor });
  }
  const firstPostOfDoc = (docId) => [...tabMap.entries()].find(([k]) => k.startsWith(`${docId}|`))?.[1];

  // 4. Render and write each post.
  await fs.mkdir(P.posts, { recursive: true });
  for (const it of items) {
    const { p, prev, title, slug } = it;
    const url = `/${slug}/`;
    const warn = (m) => report.warnings.push(`"${title}": ${m}`);
    const resolve = (link) => {
      const at = (t) => (t.url === url ? (t.anchor ? `#${t.anchor}` : '#top') : t.url + (t.anchor ? `#${t.anchor}` : ''));
      if (link.kind === 'url') {
        const m = link.url.match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([\w-]+)/);
        if (!m) return link.url;
        const tab = link.url.match(/[?&#]tab=(t\.[\w-]+)/)?.[1];
        const heading = link.url.match(/heading=(h\.[\w-]+)/)?.[1];
        const target = (tab && heading && headingMap.get(`${m[1]}|${tab}|${heading}`)) || (tab && tabMap.get(`${m[1]}|${tab}`)) || firstPostOfDoc(m[1]);
        if (target) return at(target);
        warn(`a link points to a Google Doc that isn't on the blog (${link.url}). Readers may not be able to open it.`);
        return link.url;
      }
      if (link.kind === 'heading') {
        const t = headingMap.get(`${p.docId}|${link.tabId}|${link.id}`);
        if (t) return at(t);
        warn('a link to a heading points somewhere that isn\'t published, so it was turned into plain text.');
        return null;
      }
      if (link.kind === 'tab') {
        const t = tabMap.get(`${p.docId}|${link.tabId}`);
        if (t) return at(t);
        warn('a link to another tab points at a tab that isn\'t published, so it was turned into plain text.');
        return null;
      }
      return null;
    };

    dropTitleHeading(p, title);

    // Images
    const mediaDir = path.join(P.media, slug);
    const urlBase = `/media/${slug}`;
    const images = collectImages(p);
    const imageMap = new Map();
    const buffers = new Map();
    const keep = new Set();
    for (const img of images) {
      if (imageMap.has(img.key)) continue;
      try {
        const buf = await download(img.contentUri, source.token);
        const r = await processImage(buf, mediaDir, urlBase);
        imageMap.set(img.key, r);
        buffers.set(img.key, buf);
        r.files.forEach((f) => keep.add(f));
      } catch (e) {
        warn(`an image couldn't be downloaded (${e.message}), so it was left out.`);
      }
    }
    const ordered = [...new Set(images.map((i) => i.key))].filter((k) => imageMap.has(k));
    let cover = null;
    if (it.cover.index > 0 && ordered.length) {
      let key = ordered[it.cover.index - 1];
      if (!key) { warn(`Cover is set to image ${it.cover.index}, but the post has ${ordered.length} image(s). The first one is used.`); key = ordered[0]; }
      const r = imageMap.get(key);
      const og = await makeOgImage(buffers.get(key), mediaDir, urlBase);
      keep.add(og.file);
      const alt = images.find((i) => i.key === key)?.alt || '';
      cover = r.animated
        ? { src: r.src, thumb: r.src, width: r.width, height: r.height, alt, og: og.url }
        : { src: r.src, thumb: r.thumb, avif: r.avif, webp: r.webp, width: r.width, height: r.height, alt, og: og.url };
    }

    const firstBlocks = p.sections[0]?.blocks || [];
    const firstFig = firstBlocks.findIndex((b) => b.type === 'figure');
    const eagerKey = firstFig > -1 && firstFig < 4 ? firstBlocks[firstFig].images[0]?.key : null;

    const html = renderPost(p, { images: imageMap, resolve, eagerKey });
    const words = wordCount(html);
    const front = {
      title,
      summary: nfc(it.summaryField || p.state.subtitleText || truncate(firstParagraph(p), 160)),
      date: it.date,
      topics: it.tags,
      series: it.series,
      seriesSlug: it.series ? slugify(it.series) : null,
      slug,
      permalink: url,
      cover,
      wordCount: words,
      readingMinutes: Math.max(1, Math.round(words / 220)),
      draft: it.status === 'draft',
      source: { doc: it.d.name, tab: p.tabTitle },
    };
    const contentHash = sha(JSON.stringify({ front, html }));
    front.dateModified = !prev ? it.date : prev.contentHash === contentHash ? prev.dateModified || it.date : today;

    // Slug changed: move it and leave a redirect behind.
    const oldSlugs = new Set(prev?.oldSlugs || []);
    if (prev?.slug && prev.slug !== slug) {
      oldSlugs.add(prev.slug);
      await fs.rm(path.join(P.posts, prev.slug), { recursive: true, force: true });
      await fs.rm(path.join(P.media, prev.slug), { recursive: true, force: true });
    }
    oldSlugs.delete(slug);

    const file = path.join(P.posts, slug, 'index.html');
    const exists = await fs.access(file).then(() => true, () => false);
    if (!prev || prev.contentHash !== contentHash || !exists || force) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `---json\n${JSON.stringify(front, null, 2)}\n---\n${html}\n`, 'utf8');
    }
    // Remove images the post no longer uses.
    try {
      for (const f of await fs.readdir(mediaDir)) if (!keep.has(f)) await fs.rm(path.join(mediaDir, f));
      if (!keep.size) await fs.rm(mediaDir, { recursive: true, force: true });
    } catch { /* no media folder */ }

    const entry = { slug, title, date: it.date, dateModified: front.dateModified, contentHash, docId: p.docId, docName: it.d.name, tabIds: p.tabIds, sections: Object.fromEntries(p.state.sectionAnchors), oldSlugs: [...oldSlugs] };
    if (!prev) report.added.push({ title, url });
    else if (prev.contentHash !== contentHash) report.updated.push({ title, url });
    else report.unchanged.push({ title, url });
    report.warnings.push(...p.warnings.map((w) => `"${title}": ${w}`));
    if (!opts.preview || it.status !== 'draft') state.posts[p.key] = entry;
  }

  for (const { d } of fetched) state.docs[d.id] = { name: d.name, modifiedTime: d.modifiedTime };
  if (!listFailed) for (const id of Object.keys(state.docs)) if (!list.some((d) => d.id === id)) delete state.docs[id];

  // 5. Take down posts that have gone (with a safety catch).
  const gone = Object.keys(state.posts).filter((k) => !seen.has(k));
  const hardBlock = listFailed || (!list.length && !opts.allowRemovals);
  const tooMany = gone.length > MAX_REMOVALS && !opts.allowRemovals;
  if (gone.length && (hardBlock || tooMany)) {
    if (tooMany && !hardBlock) report.errors.push(`${gone.length} posts would have been taken down in one go (${gone.map((k) => state.posts[k].title).join(', ')}). That looks like a mistake, so nothing was removed. If it's intended, run the workflow again with "Allow removals" ticked.`);
  } else {
    for (const k of gone) {
      const v = state.posts[k];
      await fs.rm(path.join(P.posts, v.slug), { recursive: true, force: true });
      await fs.rm(path.join(P.media, v.slug), { recursive: true, force: true });
      report.removed.push({ title: v.title, url: `/${v.slug}/`, why: report.drafts.includes(v.title) ? 'set to Draft' : 'no longer in the folder' });
      delete state.posts[k];
    }
  }

  // 6. Redirects from old addresses.
  const redirects = [];
  for (const v of Object.values(state.posts)) for (const from of v.oldSlugs || []) redirects.push({ from, to: v.slug });

  if (!opts.preview) {
    state.converterVersion = CONVERTER_VERSION;
    await fs.mkdir(path.dirname(P.state), { recursive: true });
    await fs.writeFile(P.state, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }
  await fs.writeFile(P.redirects, JSON.stringify(redirects, null, 2) + '\n', 'utf8');

  // Problems are reported, but the run still succeeds so the site builds.
  await sendReport(report, site);
}

async function sendReport(r, site) {
  const base = (site.url || '').replace(/\/$/, '');
  const link = (x) => `[${x.title}](${base}${x.url})`;
  const lines = [`### Blog sync${opts.preview ? ' (preview only, nothing published)' : ''}`, ''];
  const section = (label, arr, fmt) => { if (arr.length) lines.push(`**${label}**`, ...arr.map((x) => `- ${fmt(x)}`), ''); };
  section('New posts', r.added, link);
  section('Updated posts', r.updated, link);
  section('Taken down', r.removed, (x) => `${x.title} (${x.why})`);
  section('Held back as drafts', r.drafts, (x) => x);
  section('Problems', r.errors, (x) => x);
  section('Worth checking', r.warnings, (x) => x);
  if (r.unchanged.length) lines.push(`${r.unchanged.length} post(s) unchanged.`, '');
  if (!r.added.length && !r.updated.length && !r.removed.length && !r.errors.length) lines.push('No changes.', '');
  if (r.ignoredTabs.length) lines.push('<details><summary>Tabs without a details table (not posts)</summary>', '', ...r.ignoredTabs.map((x) => `- ${x}`), '', '</details>', '');
  const md = lines.join('\n');
  console.log(md);
  await writeSummary(md);

  if (!opts.preview && (r.removed.length || r.errors.length || r.warnings.length)) {
    const title = r.errors.length ? 'Blog: a publishing run needs a look' : r.removed.length ? 'Blog: posts taken down' : 'Blog: things worth checking';
    await openOrUpdateIssue(title, md);
  }
}

main().catch(async (e) => {
  console.error(e);
  await writeSummary(`### Blog sync failed\n\n\`${e.message}\``);
  await openOrUpdateIssue('Blog: a publishing run needs a look', `The sync crashed:\n\n\`\`\`\n${e.stack || e.message}\n\`\`\``);
  process.exit(1);
});
