// Builds offline test data in the same shape the Google Docs API returns
// (documents.get with includeTabsContent=true), using the CONCEPT tab text
// plus a test tab that exercises images, captions, credits, lists, tables,
// footnotes, links between tabs, child tabs and decomposed macrons.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'fixtures');

// ── tiny builders ────────────────────────────────────────────────
// Inline markup for fixtures only: **bold**, *italic*, [text](url), [text](#tab:t.x), ^n^ footnote
function runs(src, base = {}) {
  const out = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|\[(.+?)\]\((.+?)\)|\^(\w+)\^/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ textRun: { content: src.slice(last, m.index), textStyle: { ...base } } });
    if (m[1]) out.push(...runs(m[1], { ...base, bold: true }));
    else if (m[2]) out.push(...runs(m[2], { ...base, italic: true }));
    else if (m[3]) {
      const target = m[4];
      const link = target.startsWith('#tab:') ? { tabId: target.slice(5) }
        : target.startsWith('#heading:') ? { heading: { id: target.split(':')[1], tabId: target.split(':')[2] } }
        : { url: target };
      out.push(...runs(m[3], { ...base, link, underline: true, foregroundColor: { color: { rgbColor: { blue: 0.8 } } } }));
    } else if (m[5]) out.push({ footnoteReference: { footnoteId: `fn.${m[5]}`, footnoteNumber: m[5] } });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ textRun: { content: src.slice(last), textStyle: { ...base } } });
  return out;
}

function para(elements, { style = 'NORMAL_TEXT', bullet, headingId } = {}) {
  const els = typeof elements === 'string' ? runs(elements) : elements;
  const last = els.at(-1);
  if (last?.textRun) last.textRun.content += '\n';
  else els.push({ textRun: { content: '\n', textStyle: {} } });
  return { paragraph: { elements: els, paragraphStyle: { namedStyleType: style, ...(headingId ? { headingId } : {}), lineSpacing: 115, direction: 'LEFT_TO_RIGHT' }, ...(bullet ? { bullet } : {}) } };
}
const P = (s) => para(s);
const H = (n, s, id) => para(s, { style: `HEADING_${n}`, headingId: id || `h.${Math.random().toString(36).slice(2, 10)}` });
const BULLET = (s, level = 0, listId = 'kix.bullets') => para(s, { bullet: { listId, nestingLevel: level } });
const NUM = (s, level = 0) => BULLET(s, level, 'kix.numbers');
const EMPTY = () => para('');
const IMG = (id) => para([{ inlineObjectElement: { inlineObjectId: id, textStyle: {} } }]);
const IMGS = (...ids) => para(ids.map((id) => ({ inlineObjectElement: { inlineObjectId: id, textStyle: {} } })));
const CAPTION = (s) => para(runs(s, { italic: true }));

function table(rows, { headerBold = false, pinned = false } = {}) {
  return {
    table: {
      rows: rows.length,
      columns: rows[0].length,
      tableRows: rows.map((r, ri) => ({
        tableRowStyle: { minRowHeight: { unit: 'PT' }, ...(pinned && ri === 0 ? { tableHeader: true } : {}) },
        tableCells: r.map((c) => ({ content: [para(runs(c, headerBold && ri === 0 ? { bold: true } : {}))], tableCellStyle: { rowSpan: 1, columnSpan: 1, backgroundColor: {} } })),
      })),
      tableStyle: { tableColumnProperties: [] },
    },
  };
}
const details = (obj) => table(Object.entries(obj).map(([k, v]) => [k, v]));

const LISTS = {
  'kix.bullets': { listProperties: { nestingLevels: [{ glyphSymbol: '●' }, { glyphSymbol: '○' }, { glyphSymbol: '■' }] } },
  'kix.numbers': { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL', glyphFormat: '%0.' }, { glyphType: 'ALPHA' }] } },
};

function tab(tabId, title, content, { children = [], inlineObjects = {}, footnotes = {} } = {}) {
  return {
    tabProperties: { tabId, title, index: 0 },
    childTabs: children,
    documentTab: {
      body: { content: [{ sectionBreak: { sectionStyle: {} } }, ...content] },
      lists: LISTS,
      inlineObjects,
      footnotes,
      documentStyle: {},
      namedStyles: {},
    },
  };
}

function image(id, file, { alt = '', title = '' } = {}) {
  return { [id]: { objectId: id, inlineObjectProperties: { embeddedObject: { title, description: alt, imageProperties: { contentUri: `fixture:${file}`, cropProperties: {} }, size: { width: { magnitude: 450, unit: 'PT' }, height: { magnitude: 250, unit: 'PT' } } } } } };
}

// ── placeholder images ───────────────────────────────────────────
async function makeImages(dir) {
  await fs.mkdir(dir, { recursive: true });
  const svg = (w, h, a, b, label) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <path d="M0 ${h * 0.72} Q ${w * 0.25} ${h * 0.5} ${w * 0.5} ${h * 0.66} T ${w} ${h * 0.6} V ${h} H 0 Z" fill="#1d2a1f"/>
    <path d="M0 ${h * 0.85} Q ${w * 0.3} ${h * 0.7} ${w * 0.65} ${h * 0.82} T ${w} ${h * 0.78} V ${h} H 0 Z" fill="#0d140f"/>
    <text x="${w * 0.04}" y="${h * 0.12}" font-family="sans-serif" font-size="${Math.round(h * 0.05)}" fill="#ffffff" opacity="0.7">${label}</text>
  </svg>`);
  const files = {
    map: [2400, 1350, '#6b7d8c', '#c9b48a', 'TEST IMAGE 1: base map'],
    kinder: [1600, 1060, '#8a5a44', '#e3c28f', 'TEST IMAGE 2: painting'],
    kitA: [1200, 900, '#3d5a40', '#9fb38a', 'TEST 3a: forest kit'],
    kitB: [1200, 900, '#4a4a3a', '#b3a77a', 'TEST 3b: scrub kit'],
    chart: [1800, 900, '#202020', '#5a5a5a', 'TEST IMAGE 4: food calendar'],
  };
  const out = {};
  for (const [name, [w, h, a, b, label]] of Object.entries(files)) {
    const f = path.join(dir, `${name}.png`);
    await sharp(svg(w, h, a, b, label)).png().toFile(f);
    out[name] = path.relative(path.join(HERE, '..'), f);
  }
  return out;
}

// ── the CONCEPT tab, as written in the Doc ───────────────────────
function conceptContent(meta) {
  return [
    details(meta),
    EMPTY(),
    P('"Sid\'s original premise was: \'Let\'s put all of human history in a box and make it fun.\'"'),
    BULLET('Ed Beach, Creative Director of the Civilization franchise'),
    H(1, 'Concept'),
    P('Taua is a grand strategy game set in Aotearoa New Zealand between 1810 and 1872, You control a hapū (a sub tribal group) through 62 years of political, military and cultural upheaval. In a campaign of taua you will face challenges from european powers, other tribes, hapū within your iwi and even other rangatira.'),
    EMPTY(),
    P('You begin in a world where the first european technologies and ideas are entering maori society. First you must navigate through the period of upheaval and warfare that arrives in its wake. It is a time of great opportunity, where once stable systems are thrown into flux and enterprising leaders can reap great prestige, power and bounty. hapū must balance acquiring boons from the newly arriving Europeans with retaining tribal authority and cultural hegemony.'),
    EMPTY(),
    P('Around halfway into the game a new balance of power will have been established and intertribal warfare has settled, however the pace of arrivals from overseas will accelerate, and the British (or French) will seek to establish colonial authority over these new arrivals through a treaty. This new power will be your chief antagonist throughout the latter half of the game. Rather than seeking to expand individually you must now seek to consolidate power, defend your autonomy and ensure you last through to the end of the game. You can do this individually or seek to create coalitions, confederations or even a kingship. By the 1870s you will now be vastly outnumbered by these new arrivals, and pressured in on all fronts.'),
    H(1, 'Core Pillars'),
    H(2, 'Tikanga, above all'),
    P('All information, systems, icons, and interactions should be rooted in mātauranga Māori. It shapes the lens all decisions are made through.'),
    H(2, 'Utu'),
    P('The game is based around this alive ledger. You inherit a list of grievances and debts, the larger the outstanding list the greater the drain on your mana. Many actions you take revolve around clearing your ledger. However actions you take can also create entry in others ledgers, and they will also seek to balance their utu.'),
    H(2, 'A Reactive World'),
    P('19th century Aotearoa is a place in flux. The world of Taua should feel dynamic and in constant change. All systems should be interwoven and reactive. Causality is key.Events throughout the game set you off on dynamic paths and actions you take will affect future challenges. Players should see the repercussions of their choices, and have them generate new problems to overcome and opportunities to exploit.'),
    H(2, 'Time Marches On'),
    P('No matter what, seasons change. Your toa will have to return to their kāinga to harvest crops. Nothing stops time rolling on, and every decision you make moves the clock forward.'),
    H(2, 'Whakapapa Matters'),
    P('In the Māori world, whakapapa is one of the most esteemed forms of knowledge, and great efforts have been made to retain it. Relationships and connections define many decisions and responsibilities. In Taua relationality and whakapapa defines where you may or may not act, who will join you and who will oppose you.'),
    H(2, 'Unfolding Information'),
    P('The people in Aotearoa at that time didn\'t know what would happen, and what was happening everywhere in the country. You will need to collect information through diplomacy, trade, and rumours continually. Technology and events are not certain to fire at given times.'),
    H(1, 'Core Tension'),
    P('You want to grow your political network and economic power base. However, every method to do so brings with it instability. The hapū and iwi system was sophisticated and efficient, but also enabled the keeping of utu, and for any small gain to draw many distant relations into conflict against you. European contact provides an advantage, but opens you up to danger also.'),
    EMPTY(),
  ];
}

// Decomposed macrons (a + U+0304) to prove they come out as single characters.
const D = (s) => s.normalize('NFD');

function whenuaContent(meta) {
  return [
    details(meta),
    H(1, 'Whenua'),
    P(`Ko au ko te whenua. If the land is the people, then the map can't just be a board for the game to sit on. It needs to look like **Aotearoa in 1810**, change through the year the way the land did, and give food the way the land gave it. ${D('Kūmara, tāmure, kōura and ōi')} all come into it. See the [concept post](#tab:t.concept) for the pillars, and [Te Ara](https://teara.govt.nz/en/interactive/40552/harvest-seasons-diagram) for the charts.^1^`),
    H(2, 'What it looked like/1810', 'h.looked'),
    P('Modern map data shows the land as it is now. So I started from the ground up with *LINZ* topographic data and Landcare Research\'s potential vegetation layer.'),
    IMG('kix.map'),
    CAPTION('The base map of the North Island, cut back to the cover around 1840.\u000bLINZ topographic data, CC BY 4.0'),
    P('Some of the land has changed shape since 1810, and the map has to undo that:'),
    BULLET('The Hauraki Plains and lower Waikato were swamp and kahikatea forest.'),
    BULLET('Te Whanganui-a-Orotū was open water until the 1931 earthquake.', 1),
    BULLET('Tarawera stood as three intact domes, with no rift.'),
    IMG('kix.kinder'),
    CAPTION('John Kinder, Tarawera Mountain from above Te Ariki, 1864. The flat-topped domes before the 1886 eruption. Credit: Alexander Turnbull Library, A-036-013.'),
    H(2, 'Kits'),
    P('Each landscape type gets a kit, with the share of each plant set as a percentage:'),
    table([['Kit', 'Canopy', 'Share'], ['Northern kauri forest', 'kauri, taraire', '60%'], ['Kahikatea swamp forest', 'kahikatea', '70%'], [D('Bracken fernland'), 'aruhe, mānuka', '—']], { headerBold: true }),
    IMGS('kix.kitA', 'kix.kitB'),
    CAPTION('Forest and scrub kits side by side.\u000bReference photos: author'),
    P('The order I\'m building them in:'),
    NUM('Greybox the land shape.'),
    NUM('Rivers and settlements.'),
    NUM('Forest kits.', 1),
    NUM('The art pass.'),
    P('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    P('Back to [the 1810 section](#heading:h.looked:t.whenua).'),
  ];
}

function kitsChild() {
  return [
    H(1, 'Northern kits'),
    P('Northern coastal forest runs through pōhutukawa flowering in December and January.'),
    IMG('kix.chart'),
    CAPTION('The four seasonal food charts combined into one calendar.'),
  ];
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  const imgs = await makeImages(path.join(OUT, 'images'));

  const keyTab = tab('t.key', 'Key', [P('Concept'), P('Initial Scoping'), P('Ki te kotahi te kākaho ka whati, ki te kāpuia e kore e whati')]);
  const draftsDoc = (whenuaMeta, conceptMeta) => ({
    documentId: 'doc-drafts',
    title: 'Taua_Blog_drafts',
    revisionId: 'r1',
    tabs: [
      keyTab,
      tab('t.concept', 'Concept', conceptContent(conceptMeta)),
      tab('t.whenua', 'Whenua', whenuaContent(whenuaMeta), {
        inlineObjects: { ...image('kix.map', imgs.map, { alt: 'Shaded relief map of the North Island with forest cover' }), ...image('kix.kinder', imgs.kinder), ...image('kix.kitA', imgs.kitA), ...image('kix.kitB', imgs.kitB) },
        footnotes: { 'fn.1': { footnoteId: 'fn.1', content: [P('The charts are general, so timing shifts from north to south.')] } },
        children: [
          tab('t.kits', 'Kits detail', kitsChild(), { inlineObjects: image('kix.chart', imgs.chart) }),
          tab('t.notes', '_notes', [P('Private notes that must never be published.')]),
        ],
      }),
      tab('t.coreloop', 'Core Loop', [details({ Title: 'Core loop', Status: 'Draft' }), P('Not ready yet.')]),
    ],
  });

  const manaDoc = {
    documentId: 'doc-mana',
    title: 'Mana and utu',
    tabs: [tab('t.0', 'Tab 1', [details({ Title: 'Mana and utu', Date: '2026-11-02', Tags: 'mana, utu', Summary: 'A first pass on mana and utu.' }), P('Short test post that run 2 takes down.')])],
  };

  const conceptMeta = { Title: '', Date: '', Summary: '', Tags: 'Design, Pillars, tikanga', Series: '', Cover: '', Status: '' };
  const whenuaMeta = { Title: 'Whenua', Date: '30 Whiringa-ā-nuku 2026', Tags: 'whenua, art, map', Cover: '2', Status: 'Publish' };

  // Run 1: both Docs in the folder.
  const r1 = path.join(OUT, 'run1');
  await fs.mkdir(r1, { recursive: true });
  await fs.writeFile(path.join(r1, 'drafts.json'), JSON.stringify(draftsDoc(whenuaMeta, conceptMeta), null, 1));
  await fs.writeFile(path.join(r1, 'mana.json'), JSON.stringify(manaDoc, null, 1));
  await fs.writeFile(path.join(r1, 'folder.json'), JSON.stringify([
    { id: 'doc-drafts', name: 'Taua_Blog_drafts', modifiedTime: '2026-10-30T00:00:00Z', file: 'drafts.json' },
    { id: 'doc-mana', name: 'Mana and utu', modifiedTime: '2026-10-30T00:00:00Z', file: 'mana.json' },
  ], null, 1));

  // Run 2: Mana doc removed from the folder, Whenua given a new slug, Concept title edited.
  const r2 = path.join(OUT, 'run2');
  await fs.mkdir(r2, { recursive: true });
  await fs.writeFile(path.join(r2, 'drafts.json'), JSON.stringify(draftsDoc({ ...whenuaMeta, Slug: 'whenua-1810' }, { ...conceptMeta, Title: 'The concept' }), null, 1));
  await fs.writeFile(path.join(r2, 'folder.json'), JSON.stringify([
    { id: 'doc-drafts', name: 'Taua_Blog_drafts', modifiedTime: '2026-10-31T00:00:00Z', file: 'drafts.json' },
  ], null, 1));
  console.log('Fixtures written to', OUT);
}

main();
