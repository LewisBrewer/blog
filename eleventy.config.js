import { feedPlugin } from '@11ty/eleventy-plugin-rss';
import { slugify } from './converter/util.mjs';

const site = (await import('./src/_data/site.json', { with: { type: 'json' } })).default;

const byDateDesc = (a, b) => b.date - a.date || a.data.title.localeCompare(b.data.title);

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ 'src/assets': 'assets' });
  eleventyConfig.addPassthroughCopy({ 'src/media': 'media' });
  eleventyConfig.addPassthroughCopy({ 'src/static': '/' });
  // The Taua map: tiles and data built by map/build.mjs (see map/README.md).
  eleventyConfig.addPassthroughCopy({ 'map-build': 'map' });
  eleventyConfig.addWatchTarget('src/assets/');

  // ── collections ─────────────────────────────────────────────
  eleventyConfig.addCollection('posts', (api) => api.getFilteredByTag('post').sort(byDateDesc));

  // Every series a post belongs to, main one first: [{ name, slug }].
  // Reads seriesAll (several series) or falls back to series/seriesSlug (one).
  const seriesOf = (d) =>
    Array.isArray(d?.seriesAll) && d.seriesAll.length
      ? d.seriesAll
      : d?.series ? [{ name: d.series, slug: d.seriesSlug || slugify(d.series) }] : [];

  const group = (api, field) => {
    const map = new Map();
    for (const post of api.getFilteredByTag('post').sort(byDateDesc)) {
      const values = field === 'topics' ? (post.data.topics || []).map((name) => ({ name, slug: slugify(name) })) : seriesOf(post.data);
      for (const { name, slug } of values) {
        if (!map.has(slug)) map.set(slug, { name, slug, posts: [] });
        map.get(slug).posts.push(post);
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  };
  eleventyConfig.addCollection('topicList', (api) => group(api, 'topics'));
  eleventyConfig.addCollection('seriesList', (api) =>
    group(api, 'series').map((s) => ({ ...s, posts: [...s.posts].reverse() })) // oldest first
  );

  // ── filters ─────────────────────────────────────────────────
  const fmt = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const short = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const toDate = (d) => (d instanceof Date ? d : new Date(d));
  eleventyConfig.addFilter('dateLong', (d) => fmt.format(toDate(d)));
  eleventyConfig.addFilter('dateShort', (d) => short.format(toDate(d)));
  eleventyConfig.addFilter('dateIso', (d) => toDate(d).toISOString().slice(0, 10));
  eleventyConfig.addFilter('dateFull', (d) => toDate(d).toISOString());
  eleventyConfig.addFilter('slug', (s) => slugify(s));
  eleventyConfig.addFilter('absolute', (u) => (!u ? '' : /^https?:/.test(u) ? u : site.url.replace(/\/$/, '') + u));
  eleventyConfig.addFilter('limit', (arr, n) => (arr || []).slice(0, n));
  eleventyConfig.addFilter('year', () => new Date().getFullYear());

  // Where a post sits in one series: { name, slug, position, total, prev, next }
  const navIn = (seriesList, slug, url) => {
    const s = (seriesList || []).find((x) => x.slug === slug);
    if (!s) return null;
    const i = s.posts.findIndex((p) => p.url === url);
    if (i < 0) return null;
    return { name: s.name, slug: s.slug, position: i + 1, total: s.posts.length, prev: s.posts[i - 1] || null, next: s.posts[i + 1] || null };
  };
  eleventyConfig.addFilter('seriesNav', navIn);
  // The same for every series the post is in, main series first.
  eleventyConfig.addFilter('seriesNavs', (seriesList, data, url) =>
    seriesOf(data).map((x) => navIn(seriesList, x.slug, url)).filter(Boolean)
  );
  eleventyConfig.addFilter('seriesOf', seriesOf);
  eleventyConfig.addFilter('seriesSlugs', (data) => seriesOf(data).map((x) => x.slug).join(' '));

  // Structured data for a post (schema.org BlogPosting), safe to inline.
  eleventyConfig.addFilter('postSchema', (d) => {
    const url = site.url + d.page.url;
    const all = seriesOf(d).map((x) => ({ '@type': 'CreativeWorkSeries', name: x.name, url: `${site.url}/series/${x.slug}/` }));
    const main = all[0];
    const data = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: d.title,
      description: d.summary,
      url,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      datePublished: d.date ? new Date(d.date).toISOString().slice(0, 10) : undefined,
      dateModified: d.dateModified || undefined,
      inLanguage: site.language,
      wordCount: d.wordCount,
      keywords: (d.topics || []).join(', ') || undefined,
      image: d.cover ? [site.url + d.cover.og, site.url + d.cover.src] : [site.url + '/assets/og-default.jpg'],
      author: { '@type': 'Person', name: site.author.name, url: site.author.url, jobTitle: site.author.jobTitle, sameAs: site.author.sameAs },
      publisher: { '@type': 'Person', name: site.author.name, url: site.author.url },
      isPartOf: all.length > 1 ? all : main || { '@type': 'Blog', name: `${site.title} ${site.blogName}`, url: site.url + '/' },
    };
    const crumbs = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: site.blogName, item: site.url + '/' },
        ...(main ? [{ '@type': 'ListItem', position: 2, name: main.name, item: main.url }] : []),
        { '@type': 'ListItem', position: main ? 3 : 2, name: d.title, item: url },
      ],
    };
    return JSON.stringify([data, crumbs]).replace(/</g, '\\u003c');
  });

  eleventyConfig.addFilter('siteSchema', () => JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: `${site.title} ${site.blogName}`,
    description: site.description,
    url: site.url + '/',
    inLanguage: site.language,
    author: { '@type': 'Person', name: site.author.name, url: site.author.url, sameAs: site.author.sameAs },
  }).replace(/</g, '\\u003c'));

  // ── feed ────────────────────────────────────────────────────
  eleventyConfig.addPlugin(feedPlugin, {
    type: 'atom',
    outputPath: '/feed.xml',
    collection: { name: 'post', limit: 20 },
    metadata: {
      language: site.language,
      title: `${site.title}: ${site.blogName}`,
      subtitle: site.description,
      base: site.url + '/',
      author: { name: site.author.name },
    },
  });

  return {
    dir: { input: 'src', includes: '_includes', data: '_data', output: '_site' },
    templateFormats: ['njk', 'html'],
    // Post bodies are plain HTML from the converter: never run them through a
    // template engine, so a stray {{ or {% in a post can't break the build.
    htmlTemplateEngine: false,
  };
}
