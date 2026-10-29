// Downloads images out of the Doc and makes web versions: AVIF and WebP at
// a few widths, plus a 1200×630 JPEG for link previews. Files are named by a
// hash of the original, so an unchanged image is never re-encoded.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { sha } from './util.mjs';

const WIDTHS = [640, 1280, 1920];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function download(uri, getToken) {
  if (uri.startsWith('fixture:')) return fs.readFile(uri.slice('fixture:'.length));
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const headers = {};
      // Docs image links are signed for the requester, but some need the token too.
      if (attempt > 0 && getToken) headers.Authorization = `Bearer ${await getToken()}`;
      const res = await fetch(uri, { headers, redirect: 'follow' });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(800 * (attempt + 1));
  }
  throw lastErr;
}

async function writeIfMissing(file, make) {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, await make());
  }
}

/** Returns what the renderer needs, plus the list of files it wrote. */
export async function processImage(buf, outDir, urlBase) {
  const hash = sha(buf, 10);
  const meta = await sharp(buf, { animated: true }).metadata();
  const animated = (meta.pages || 1) > 1;
  let width = meta.width;
  let height = animated ? meta.pageHeight || meta.height : meta.height;
  if (!animated && meta.orientation >= 5) [width, height] = [height, width];
  await fs.mkdir(outDir, { recursive: true });
  const files = [];

  if (animated) {
    // Moving images (GIFs) become animated WebP, which is far smaller.
    const w = Math.min(width, 1280);
    const name = `${hash}-${w}.webp`;
    await writeIfMissing(path.join(outDir, name), () =>
      sharp(buf, { animated: true }).resize({ width: w, withoutEnlargement: true }).webp({ quality: 75, effort: 4 }).toBuffer());
    files.push(name);
    return { hash, animated: true, width: w, height: Math.round((height * w) / width), src: `${urlBase}/${name}`, files };
  }

  const widths = [...new Set(WIDTHS.map((w) => Math.min(w, width)))].sort((a, b) => a - b);
  const avif = [];
  const webp = [];
  for (const w of widths) {
    const base = sharp(buf).rotate().resize({ width: w, withoutEnlargement: true });
    const a = `${hash}-${w}.avif`;
    const b = `${hash}-${w}.webp`;
    await writeIfMissing(path.join(outDir, a), () => base.clone().avif({ quality: 60, effort: 4 }).toBuffer());
    await writeIfMissing(path.join(outDir, b), () => base.clone().webp({ quality: 80, effort: 4 }).toBuffer());
    files.push(a, b);
    avif.push(`${urlBase}/${a} ${w}w`);
    webp.push(`${urlBase}/${b} ${w}w`);
  }
  const max = widths.at(-1);
  const mid = widths.filter((w) => w <= 1280).at(-1) || widths[0];
  return {
    hash,
    animated: false,
    width: max,
    height: Math.round((height * max) / width),
    avif: avif.join(', '),
    webp: webp.join(', '),
    src: `${urlBase}/${hash}-${mid}.webp`,
    thumb: `${urlBase}/${hash}-${widths[0]}.webp`,
    files,
  };
}

/** 1200×630 JPEG for Open Graph / social previews. */
export async function makeOgImage(buf, outDir, urlBase) {
  const hash = sha(buf, 10);
  const name = `${hash}-og.jpg`;
  await fs.mkdir(outDir, { recursive: true });
  await writeIfMissing(path.join(outDir, name), () =>
    sharp(buf, { pages: 1 })
      .rotate()
      .resize({ width: 1200, height: 630, fit: 'cover', position: sharp.strategy.attention })
      .flatten({ background: '#000000' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer());
  return { url: `${urlBase}/${name}`, file: name };
}
