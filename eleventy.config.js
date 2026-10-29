import { feedPlugin } from '@11ty/eleventy-plugin-rss';
import { slugify } from './converter/util.mjs';

const site = (await import('./src/_data/site.json', { with: { type: 'json' } })).default;

const byDateDesc = (a, b) => b.date - a.date || a.data.title.localeCompare(b.data.title);

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ 'src/assets': 'assets' });
  eleventyConfig.addPassthroughCopy({ 'src/media': 'media' });
  eleventyConfig.addPassthroughCopy({ 'src/static': '/' });
  eleventyConfig.addWatchTarget('src/assets/');

  // ── collections ─────────────────────────────────────────────
  eleventyConfig.addCollection('posts', (api) => api.getFilteredByTag('post').sort(byDateDesc));

  const group = (api, field, slugField) => {
    const map = new Map();
    for (const post of api.getFilteredByTag('post').sort(byDateDesc)) {
      const values = field === 'topics' ? post.data.topics || [] : post.data.series ? [post.data.series] : [];
      for (const name of values) {
        const slug = slugField ? post.data[slugField] : slugify(name);
        if (!map.has(slug)) map.set(slug, { name, slug, posts: [] });
        map.get(slug).posts.push(post);
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  };
  eleventyConfig.addCollection('topicList', (api) => group(api, 'topics'));
  eleventyConfig.addCollection('seriesList', (api) =>
    group(api, 'series', 'seriesSlug').map((s) => ({ ...s, posts: [...s.posts].reverse() })) // oldest first
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

  // Where a post sits in its series: { position, total, prev, next }
  eleventyConfig.addFilter('seriesNav', (seriesList, slug, url) => {
    const s = (seriesList || []).find((x) => x.slug === slug);
    if (!s) return null;
    const i = s.posts.findIndex((p) => p.url === url);
    if (i < 0) return null;
    return { name: s.name, slug: s.slug, position: i + 1, total: s.posts.length, prev: s.posts[i - 1] || null, next: s.posts[i + 1] || null };
  });

  // Structured data for a post (schema.org BlogPosting), safe to inline.
  eleventyConfig.addFilter('postSchema', (d) => {
    const url = site.url + d.page.url;
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
      isPartOf: d.series
        ? { '@type': 'CreativeWorkSeries', name: d.series, url: `${site.url}/series/${d.seriesSlug}/` }
        : { '@type': 'Blog', name: `${site.title} ${site.blogName}`, url: site.url + '/' },
    };
    const crumbs = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: site.blogName, item: site.url + '/' },
        ...(d.series ? [{ '@type': 'ListItem', position: 2, name: d.series, item: `${site.url}/series/${d.seriesSlug}/` }] : []),
        { '@type': 'ListItem', position: d.series ? 3 : 2, name: d.title, item: url },
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
