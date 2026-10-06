// Builds the GitHub Pages site into _site/: the hand-written landing page in site/, plus the
// project's Markdown documents rendered as pages under docs/. Links between documents point to
// their pages; links to other repository files point to GitHub.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { marked } from 'marked';

const REPO = 'https://github.com/abrichardson/folio/blob/main/';
const OUT = '_site';
const pages = [
  { src: 'README.md', out: 'index.html', title: 'Overview' },
  { src: 'docs/DESKTOP.md', out: 'desktop.html', title: 'Build and release' },
  { src: 'docs/ARCHITECTURE.md', out: 'architecture.html', title: 'Architecture' },
  { src: 'docs/PROJECT_STATUS.md', out: 'status.html', title: 'Project status' },
  { src: 'CONTRIBUTING.md', out: 'contributing.html', title: 'Contributing' },
  { src: 'SECURITY.md', out: 'security.html', title: 'Security' },
];
const bySource = new Map(pages.map((p) => [p.src, p.out]));

const escape = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Resolves a link written in `from` (a repository path) to a page or a GitHub URL. */
function resolve(href, from) {
  if (/^([a-z]+:|#|\/\/)/i.test(href)) return href;
  const [path, hash = ''] = href.split('#');
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const parts = [];
  for (const seg of (base + path).split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  const target = parts.join('/');
  const page = bySource.get(target);
  if (page) return page + (hash ? '#' + hash : '');
  return REPO + target + (hash ? '#' + hash : '');
}

function render(page) {
  const md = readFileSync(page.src, 'utf8');
  const renderer = new marked.Renderer();
  const link = renderer.link.bind(renderer);
  renderer.link = (token) => link({ ...token, href: resolve(token.href, page.src) });
  const body = marked.parse(md, { renderer, gfm: true });
  const nav = pages
    .map(
      (p) =>
        `<a href="${p.out}"${p.out === page.out ? ' aria-current="page"' : ''}>${escape(p.title)}</a>`,
    )
    .join('\n          ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(page.title)} · Folio docs</title>
    <link rel="icon" href="../favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="../style.css" />
  </head>
  <body>
    <header class="top">
      <div class="wrap">
        <a class="brand" href="../"><img src="../favicon.svg" alt="" />folio<b>.</b></a>
        <nav class="links" aria-label="Site">
          <a href="../#features" class="wide">Features</a>
          <a href="./">Docs</a>
          <a href="https://github.com/abrichardson/folio">GitHub</a>
        </nav>
      </div>
    </header>
    <main class="wrap">
      <nav class="doc-nav" aria-label="Documentation">
          ${nav}
      </nav>
      <article class="doc">
${body}
      </article>
    </main>
    <footer>
      <div class="wrap">
        <span>Folio · MIT License</span>
        <span><a href="${REPO}${page.src}">View this page's source</a></span>
      </div>
    </footer>
  </body>
</html>
`;
}

rmSync(OUT, { recursive: true, force: true });
cpSync('site', OUT, { recursive: true });
mkdirSync(`${OUT}/docs`, { recursive: true });
for (const page of pages) writeFileSync(`${OUT}/docs/${page.out}`, render(page));
writeFileSync(`${OUT}/.nojekyll`, '');
console.log(`Built ${OUT}/ with ${pages.length} documentation pages.`);
