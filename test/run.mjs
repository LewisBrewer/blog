// End-to-end test, offline. Copies the repo to a temp folder, runs the
// converter against fixture Docs, builds the site, and checks the output.
//   npm test            (add --keep to leave the temp folder for a look)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '  ✓' : '  ✗'} ${label}`); if (!cond) failures++; };

const run = (cwd, args, env = {}) => execFileSync(process.execPath, args, { cwd, env: { ...process.env, GOOGLE_SERVICE_ACCOUNT_JSON: '', ...env }, encoding: 'utf8' });
const read = (dir, f) => fs.readFile(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.access(path.join(dir, f)).then(() => true, () => false);

async function walkHtml(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkHtml(p)));
    else if (/\.(html|xml)$/.test(e.name)) out.push(p);
  }
  return out;
}

async function main() {
  run(REPO, ['test/build-fixtures.mjs']);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-test-'));
  for (const item of ['converter', 'src', 'test', 'eleventy.config.js', 'package.json']) await fs.cp(path.join(REPO, item), path.join(tmp, item), { recursive: true });
  await fs.symlink(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'));
  await fs.rm(path.join(tmp, 'src/media'), { recursive: true, force: true });
  for (const d of await fs.readdir(path.join(tmp, 'src/posts'))) if (d !== 'posts.json') await fs.rm(path.join(tmp, 'src/posts', d), { recursive: true });
  const eleventy = path.join(tmp, 'node_modules/@11ty/eleventy/cmd.cjs');
  const site = path.join(tmp, '_site');

  console.log('\nRun 1: two Docs in the folder');
  console.log(run(tmp, ['converter/sync.mjs', '--fixture', 'test/fixtures/run1']));
  run(tmp, [eleventy, '--quiet']);
  ok(await exists(site, 'concept/index.html'), 'Concept post built');
  ok(await exists(site, 'whenua/index.html'), 'Whenua post built');
  ok(await exists(site, 'mana-and-utu/index.html'), 'Single-tab Doc post built');
  ok(!(await exists(site, 'core-loop/index.html')), 'Draft post held back');
  ok(!(await exists(site, 'key/index.html')), 'Tab without details table ignored');

  const all = await Promise.all((await walkHtml(site)).map((f) => fs.readFile(f, 'utf8')));
  ok(all.every((h) => !h.includes('̄')), 'No decomposed macrons anywhere');
  ok(all.every((h) => !h.includes('Private notes')), '"_notes" tab never published');
  ok(all.every((h) => !/style="|font-family:|class="c\d/.test(h.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<body style="[^"]*"/g, ''))), 'No Google inline styling');

  const concept = await read(site, 'concept/index.html');
  ok(concept.includes('class="epigraph"') && concept.includes('Ed Beach'), 'Concept: epigraph with attribution');
  ok(!/<h2[^>]*>Concept<\/h2>/.test(concept), 'Concept: repeated title heading dropped');
  ok(concept.includes('mātauranga Māori'), 'Concept: macrons intact');
  ok(concept.includes('<h3 id="tikanga-above-all">Tikanga, above all</h3>'), 'Concept: Heading 2 becomes h3 with an id');
  ok(/<meta name="description" content="Taua is a grand strategy game set in Aotearoa New Zealand/.test(concept), 'Concept: summary defaults to first paragraph');
  ok(concept.includes('href="/tags/pillars/"'), 'Concept: tag links');
  ok(concept.includes('Taua dev log'), 'Concept: default series');
  const ld = JSON.parse(concept.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  ok(ld[0]['@type'] === 'BlogPosting' && ld[0].headline === 'Concept' && ld[1]['@type'] === 'BreadcrumbList', 'Concept: structured data');
  ok(concept.includes('<link rel="canonical" href="https://blog.lewisbrewer.com/concept/">'), 'Concept: canonical URL');
  ok(concept.includes('og-default.jpg'), 'Concept: no images, so default share image');

  const whenua = await read(site, 'whenua/index.html');
  ok(whenua.includes('Kūmara, tāmure, kōura and ōi'), 'Whenua: decomposed macrons recomposed');
  ok(/<figcaption><span class="caption">The base map of the North Island, cut back to the cover around 1840.<\/span><span class="credit">LINZ topographic data, CC BY 4.0<\/span><\/figcaption>/.test(whenua), 'Whenua: caption and credit split on Shift+Enter');
  ok(/<span class="caption">John Kinder[^<]*eruption. <\/span>|<span class="caption">John Kinder[^<]*eruption.<\/span><span class="credit">Credit: Alexander Turnbull Library/.test(whenua), 'Whenua: "Credit:" split into the credit line');
  ok(whenua.includes('alt="Shaded relief map of the North Island with forest cover"'), 'Whenua: alt text from the Doc');
  ok(whenua.includes('type="image/avif"') && whenua.includes('type="image/webp"'), 'Whenua: AVIF and WebP');
  ok(whenua.includes('figure--gallery'), 'Whenua: two images in one line become a pair');
  ok(/<thead><tr><th scope="col">Kit<\/th>/.test(whenua), 'Whenua: bold first row becomes table header');
  ok(/<ul><li>The Hauraki[^<]*<ul><li>Te Whanganui-a-Orotū/.test(whenua), 'Whenua: nested bullets');
  ok(/<ol><li>Greybox[\s\S]*?<ol><li>Forest kits/.test(whenua), 'Whenua: nested numbered list');
  ok(whenua.includes('href="/concept/"'), 'Whenua: link to another tab points at its post');
  ok(whenua.includes('href="#what-it-looked-like-1810"'), 'Whenua: link to a heading');
  ok(whenua.includes('youtube-nocookie.com/embed/dQw4w9WgXcQ'), 'Whenua: YouTube link becomes a player');
  ok(whenua.includes('class="footnotes"') && whenua.includes('timing shifts from north to south'), 'Whenua: footnote');
  ok(/<h2 id="kits-detail">Kits detail<\/h2>[\s\S]*<h3 id="northern-kits">Northern kits<\/h3>/.test(whenua), 'Whenua: child tab folded in as a section');
  ok(whenua.includes('<time datetime="2026-10-30">30 October 2026</time>'), 'Whenua: date in te reo month read correctly');
  ok(/og:image" content="https:\/\/blog\.lewisbrewer\.com\/media\/whenua\/[0-9a-f]+-og\.jpg/.test(whenua), 'Whenua: cover 2 used for the share image');
  ok(!/<strong> |<em> | <\/strong>| <\/em>/.test(whenua), 'Whenua: no spaces trapped inside bold or italics');

  const feed = await read(site, 'feed.xml');
  ok(feed.includes('<entry>') && feed.includes('mātauranga Māori'), 'Feed: entries with macrons');
  ok(feed.includes('https://blog.lewisbrewer.com/media/'), 'Feed: image URLs made absolute');
  const sitemap = await read(site, 'sitemap.xml');
  ok(sitemap.includes('https://blog.lewisbrewer.com/whenua/') && sitemap.includes('<lastmod>'), 'Sitemap');
  ok((await read(site, 'robots.txt')).includes('Sitemap: https://blog.lewisbrewer.com/sitemap.xml'), 'robots.txt');
  const widget = await read(site, 'widget/latest/index.html');
  ok((widget.match(/class="item"/g) || []).length === 3, 'Widget: lists the posts');
  ok(await exists(site, 'series/taua-dev-log/index.html') && await exists(site, 'tags/whenua/index.html'), 'Series and tag pages');

  const conceptDate = Object.values(JSON.parse(await read(tmp, 'data/state.json')).posts).find((p) => p.slug === 'concept').date;
  console.log('\nRun 2: one Doc removed, a slug changed, a title edited');
  console.log(run(tmp, ['converter/sync.mjs', '--fixture', 'test/fixtures/run2']));
  await fs.rm(site, { recursive: true, force: true });
  run(tmp, [eleventy, '--quiet']);
  ok(!(await exists(site, 'mana-and-utu/index.html')), 'Removed Doc: post taken down');
  ok(!(await exists(tmp, 'src/media/mana-and-utu')), 'Removed Doc: its images deleted');
  ok(await exists(site, 'whenua-1810/index.html'), 'New slug published');
  ok((await read(site, 'whenua/index.html')).includes('url=/whenua-1810/'), 'Old address redirects');
  const c2 = await read(site, 'concept/index.html');
  ok(c2.includes('<h1 class="post-title">The concept</h1>'), 'Title edit shows up');
  ok(!(await exists(site, 'the-concept/index.html')), 'Address stays /concept/ after a title edit');
  const state = JSON.parse(await read(tmp, 'data/state.json'));
  ok(Object.values(state.posts).find((p) => p.slug === 'concept').date === conceptDate, 'Concept keeps its first published date');

  console.log('\nRun 3: folder comes back empty (e.g. sharing broken)');
  const r3 = path.join(tmp, 'test/fixtures/run3');
  await fs.mkdir(r3, { recursive: true });
  await fs.writeFile(path.join(r3, 'folder.json'), '[]');
  const out3 = run(tmp, ['converter/sync.mjs', '--fixture', 'test/fixtures/run3']);
  ok(out3.includes('looks empty') && await exists(tmp, 'src/posts/concept/index.html'), 'Empty folder: nothing taken down, problem reported');

  console.log(`\n${failures ? `${failures} check(s) failed` : 'All checks passed'}`);
  if (keep) console.log(`Test site left at ${site}`);
  else await fs.rm(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main();
