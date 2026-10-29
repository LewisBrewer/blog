# blog.lewisbrewer.com

Lewis Brewer's dev log. Posts are written in Google Docs and published by a
GitHub Action, so nobody has to touch this code to post.

## How it works

1. A Doc goes into the Drive folder (Blog/Published).
2. Every morning, or when you press **Run workflow** on the Actions tab, the
   job reads every Doc in that folder.
3. Any tab with a **details table** at the top becomes a post. Child tabs
   without a table fold into that post as sections. Tabs whose name starts
   with `_` and tabs without a table are never published.
4. The converter writes clean HTML and web-sized images into `src/posts` and
   `src/media`, commits them, and Eleventy builds the site onto GitHub Pages.
5. A post that leaves the folder, loses its tab, or is set to `Draft` is taken
   down. More than two at once is treated as a mistake and only reported.

Anything that needs a look (a post taken down, an image that failed, a date it
couldn't read) opens a GitHub issue, which GitHub emails to you.

## The details table

| Field   | If left blank |
|---------|---------------|
| Title   | The tab name |
| Date    | The day it first goes live, then fixed |
| Summary | The first paragraph, trimmed |
| Tags    | None. Separate with commas |
| Series  | Taua dev log (write `none` for no series) |
| Cover   | The first image. A number picks another, `none` for no cover |
| Status  | Publish. `Draft` holds it back or takes it down |
| Slug    | The title without macrons. Fixed after the first publish |

Under an image, an italic paragraph is its caption. Press Shift+Enter inside
the caption and put the credit on the second line (or start it with
`Credit:`). A quote followed by a single bullet becomes an epigraph. A
paragraph that's only a YouTube or Vimeo link becomes a player.

## Layout

```
converter/            Google Drive + Docs API → post files
  sync.mjs            the job: fetch, convert, images, removals, report
  docs-to-html.mjs    Docs JSON → blocks → clean HTML
  meta.mjs            details table, dates, tags, status
  images.mjs          download + AVIF/WebP/OG images (sharp)
  google.mjs          service-account access, read only
src/                  Eleventy site
  _data/site.json     names, links, giscus and analytics settings
  _includes/          layouts and card macros
  assets/             CSS, fonts, default share image
  posts/  media/      written by the converter, don't edit by hand
  widget/latest.njk   the "latest posts" iframe for Readymag
data/state.json       what's published, first-publish dates, slugs
scripts/relativize.mjs  makes preview downloads open from a folder
test/                 offline end-to-end test with fixture Docs
.github/workflows/publish.yml
```

## Commands (only needed for changing the site itself)

```
npm ci          install
npm test        offline test: fixture Docs → posts → site → checks
npm start       local preview at http://localhost:8080
npm run build   build into _site
```

## Fonts

Inter (SIL Open Font License, see `src/assets/fonts/Inter-LICENSE.txt`) and
BN Romaine (Lewis's own). Graphik needs a separate web licence from
Commercial Type before it can be self-hosted here; swap it into
`--sans` in `src/assets/css/site.css` once licensed.
