// The "post details" table at the top of a tab, and the defaults applied when
// a field is left blank.
import { nfc, stripMacrons, slugify } from './util.mjs';

// Every accepted spelling of each field, lower case, macrons removed.
const FIELD_NAMES = {
  title: ['title', 'headline', 'post title'],
  date: ['date', 'published', 'publish date', 'post date'],
  summary: ['summary', 'description', 'excerpt', 'standfirst', 'intro'],
  tags: ['tags', 'tag', 'topics', 'keywords'],
  series: ['series'],
  cover: ['cover', 'cover image', 'image', 'thumbnail', 'hero'],
  status: ['status', 'state', 'publish'],
  slug: ['slug', 'url', 'address', 'web address', 'link'],
};

const LOOKUP = new Map();
for (const [field, names] of Object.entries(FIELD_NAMES)) for (const n of names) LOOKUP.set(n, field);

const HEADER_WORDS = new Set(['field', 'fields', 'detail', 'details', 'post details', 'key', 'setting', 'settings', 'property', 'blog', 'post']);

const normKey = (s) => stripMacrons(s).toLowerCase().replace(/[:*]+$/g, '').replace(/\s+/g, ' ').trim();

export function fieldFor(label) {
  return LOOKUP.get(normKey(label)) || null;
}

/**
 * rows: array of arrays of cell plain text.
 * Returns { fields: {title: '...'}, unknown: [...] } or null if this table
 * doesn't look like a details table.
 */
export function readDetailsRows(rows) {
  let body = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!body.length) return null;
  // Optional header: a merged single cell ("Post details") or "Field | Value".
  const first = body[0];
  if (first.length === 1 || (HEADER_WORDS.has(normKey(first[0])) && !fieldFor(first[0]))) body = body.slice(1);
  if (!body.length || body.some((r) => r.length < 2 || r.length > 3)) return null;
  const known = body.filter((r) => fieldFor(r[0]));
  if (!known.length || known.length < Math.ceil(body.length * 0.6)) return null;
  const fields = {};
  const unknown = [];
  for (const r of body) {
    const f = fieldFor(r[0]);
    const value = nfc(r[1]).replace(/\s+/g, ' ').trim();
    if (f) fields[f] = value;
    else unknown.push(r[0]);
  }
  return { fields, unknown };
}

const MONTHS = {
  jan: 1, january: 1, kohitatea: 1,
  feb: 2, february: 2, huitanguru: 2,
  mar: 3, march: 3, poututerangi: 3,
  apr: 4, april: 4, paengawhawha: 4,
  may: 5, haratua: 5,
  jun: 6, june: 6, pipiri: 6,
  jul: 7, july: 7, hongongoi: 7,
  aug: 8, august: 8, hereturikoka: 8,
  sep: 9, sept: 9, september: 9, mahuru: 9,
  oct: 10, october: 10, whiringaanuku: 10,
  nov: 11, november: 11, whiringaarangi: 11,
  dec: 12, december: 12, hakihea: 12,
};

const pad = (n) => String(n).padStart(2, '0');

function valid(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Accepts 2026-10-30, 30/10/2026, 30 October 2026, Oct 30 2026, 30 Whiringa-ā-nuku 2026. */
export function parseDate(input) {
  const s = stripMacrons(input).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/))) {
    // Day first, as written in Aotearoa and Australia.
    let [d, mo, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
    return valid(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  const words = s.replace(/-/g, '').split(/\s+/);
  let d, mo, y;
  for (const w of words) {
    if (/^\d{4}$/.test(w)) y = +w;
    else if (/^\d{1,2}$/.test(w)) d = +w;
    else if (MONTHS[w]) mo = MONTHS[w];
  }
  if (d && mo && y && valid(y, mo, d)) return `${y}-${pad(mo)}-${pad(d)}`;
  return null;
}

export function parseTags(value) {
  const seen = new Set();
  const tags = [];
  for (const raw of nfc(value).split(/[,;]+/)) {
    const t = raw.replace(/^#/, '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const k = slugify(t);
    if (seen.has(k)) continue;
    seen.add(k);
    tags.push(t);
  }
  return tags;
}

export function parseStatus(value) {
  const v = normKey(value || '');
  if (!v) return 'publish';
  if (/^(draft|hidden|hide|no|off|private|unpublish|unpublished|wip|not yet|hold)$/.test(v)) return 'draft';
  return 'publish';
}

export function parseCover(value) {
  const v = normKey(value || '');
  if (!v) return { index: 1 };
  if (/^(none|no|off|-)$/.test(v)) return { index: 0 };
  const n = v.match(/\d+/);
  return n ? { index: Math.max(1, +n[0]) } : { index: 1, warning: `Cover "${value}" isn't a number, so the first image is used.` };
}
