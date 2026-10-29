// Small shared helpers. Everything text-related normalises to NFC so that a
// macron typed as "a + combining macron" always ends up as the single ā.
import crypto from 'node:crypto';

export const nfc = (s) => String(s ?? '').normalize('NFC');

// Zero-width characters Google Docs sometimes leaves behind.
export const clean = (s) => nfc(s).replace(/[​‌‍⁠﻿]/g, '');

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function stripMacrons(s) {
  return nfc(s).normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

// "Mana and utu" -> "mana-and-utu", "Te Hīkoi" -> "te-hikoi"
export function slugify(s) {
  const out = stripMacrons(s)
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return out || 'post';
}

// Compare two strings ignoring case, macrons and punctuation.
export const sameText = (a, b) => slugify(a) === slugify(b);

export const sha = (data, n = 12) =>
  crypto.createHash('sha256').update(data).digest('hex').slice(0, n);

export function todayIn(timeZone) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function truncate(text, max = 160) {
  const t = nfc(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-–]+$/, '') + '…';
}

export function wordCount(html) {
  const text = String(html).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  return (text.match(/\S+/g) || []).length;
}
