// For preview downloads only: rewrites /root/links as relative ones so the
// built site works when opened straight from a folder (double-click
// index.html), with no web server.
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '_site');

async function* files(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else yield p;
  }
}

function rel(fromFile, url) {
  if (!url.startsWith('/') || url.startsWith('//')) return url;
  const [pathPart, hash = ''] = url.split('#');
  const [clean, query = ''] = pathPart.split('?');
  let target = clean.endsWith('/') ? clean + 'index.html' : clean;
  let r = path.relative(path.dirname(fromFile), path.join(root, target)).split(path.sep).join('/');
  if (!r) r = 'index.html';
  return r + (query && !target.endsWith('.html') ? `?${query}` : '') + (hash ? `#${hash}` : '');
}

for await (const f of files(root)) {
  if (f.endsWith('.html')) {
    let s = await fs.readFile(f, 'utf8');
    s = s.replace(/<link rel="preload"[^>]*>\s*/g, '');
    s = s.replace(/(\s(?:href|src))="(\/[^"]*)"/g, (m, a, u) => `${a}="${rel(f, u)}"`);
    s = s.replace(/(\ssrcset)="([^"]*)"/g, (m, a, v) => `${a}="${v.split(',').map((x) => x.trim().replace(/^(\S+)/, (u) => rel(f, u))).join(', ')}"`);
    s = s.replace(/url=(\/[^"]*)"/g, (m, u) => `url=${rel(f, u)}"`);
    await fs.writeFile(f, s);
  } else if (f.endsWith('.css')) {
    let s = await fs.readFile(f, 'utf8');
    s = s.replace(/url\("?(\/[^")]+)"?\)/g, (m, u) => `url("${rel(f, u)}")`);
    await fs.writeFile(f, s);
  }
}
console.log('Preview links made relative in', root);
