// Builds site/ from page fragments (pages/*.html) and code snippets (landing/, hello/, docs/ — they
// typecheck with the repo: `npm run typecheck`). `node site-src/build.mjs`, then
// `node site-src/check.mjs` (links, anchors, metadata, contrast). The output is plain static HTML.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HERE = import.meta.dirname;
const SITE = join(HERE, '..', 'site');
const ORIGIN = 'https://apue.dev';

// Docs navigation, in reading order (also drives prev/next).
const DOCS = [
  ['Start', [
    ['docs/index.html', 'Overview'],
    ['docs/getting-started.html', 'Getting started'],
  ]],
  ['Guides', [
    ['docs/concepts.html', 'Operations & HTTP mapping'],
    ['docs/streaming.html', 'Streaming'],
    ['docs/errors.html', 'Errors'],
    ['docs/binary-data.html', 'Binary data'],
    ['docs/batches.html', 'Pipelined batches'],
    ['docs/auth.html', 'Callers & auth'],
    ['docs/caching.html', 'Caching, CDNs & proxies'],
    ['docs/manifest.html', 'Manifest & codegen'],
  ]],
  ['Reference', [
    ['docs/server.html', 'Server reference'],
    ['docs/client.html', 'Client reference'],
    ['docs/wire-format.html', 'Wire format'],
  ]],
  ['Background', [
    ['docs/measurements.html', 'Measurements'],
    ['docs/spec.html', 'Spec & research'],
  ]],
];
const DOC_ORDER = DOCS.flatMap(([, items]) => items);

const TOP_NAV = [
  ['docs/index.html', 'Docs', (p) => p.startsWith('docs/') && !['docs/wire-format.html', 'docs/measurements.html', 'docs/spec.html'].includes(p)],
  ['docs/wire-format.html', 'Wire format'],
  ['docs/measurements.html', 'Measurements'],
  ['docs/spec.html', 'Spec'],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => esc(s).replace(/"/g, '&quot;');

// ------------------------------------------------------------------ highlighting

const KEYWORDS = {
  ts: new Set('import export from const let var function async await yield return if else for of in while try catch finally throw new type interface extends as typeof break continue class undefined null true false void'.split(' ')),
  py: new Set('from import with as def return if else elif for in while try except finally raise class None True False and or not lambda yield break continue pass'.split(' ')),
  sh: new Set([]),
};

function highlight(code, lang) {
  if (lang === 'text' || lang === 'http' || lang === 'hex') return esc(code);
  if (lang === 'console' || lang === 'sh') return highlightShell(code);
  if (lang === 'json') return highlightJson(code);
  const kw = KEYWORDS[lang] ?? new Set();
  const lineComment = lang === 'py' ? '#' : '//';
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (code.startsWith(lineComment, i)) {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      out += `<span class="tok-c">${esc(code.slice(i, stop))}</span>`;
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === '\\') j++;
        if (code[j] === '\n' && c !== '`') break;
        j++;
      }
      out += `<span class="tok-s">${esc(code.slice(i, j + 1))}</span>`;
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < code.length && /[\w$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const prev = code[i - 1];
      out += kw.has(word) && prev !== '.' ? `<span class="tok-k">${word}</span>` : esc(word);
      i = j;
    } else if (/[0-9]/.test(c) && !/[\w$]/.test(code[i - 1] ?? '')) {
      let j = i;
      while (j < code.length && /[0-9_.xa-fA-F]/.test(code[j])) j++;
      out += `<span class="tok-n">${esc(code.slice(i, j))}</span>`;
      i = j;
    } else {
      out += esc(c);
      i++;
    }
  }
  return out;
}

function highlightShell(code) {
  return code
    .split('\n')
    .map((line) => {
      if (line.startsWith('$ ')) return `<span class="tok-p">$</span> ${esc(line.slice(2))}`;
      const hash = line.match(/^(.*?)(\s#\s.*|^#.*)$/);
      if (hash) return `${esc(hash[1])}<span class="tok-c">${esc(hash[2])}</span>`;
      return esc(line);
    })
    .join('\n');
}

function highlightJson(code) {
  return esc(code).replace(/(&quot;|")((?:[^"\\]|\\.)*?)"/g, (m) => `<span class="tok-s">${m}</span>`);
}

function snippet(name) {
  const raw = readFileSync(join(HERE, name), 'utf8').replace(/\s+$/, '');
  // Lines between "-hide" and "-show" markers are typechecked but not shown.
  const lines = [];
  let hidden = false;
  for (const line of raw.split('\n')) {
    if (/^(\/\/|#)-hide\b/.test(line)) { hidden = true; continue; }
    if (/^(\/\/|#)-show\b/.test(line)) { hidden = false; continue; }
    if (!hidden) lines.push(line);
  }
  return lines.join('\n').replace(/^\n+/, '');
}

function langOf(name) {
  const ext = name.split('.').pop();
  return { ts: 'ts', py: 'py', sh: 'sh', console: 'console', json: 'json', http: 'http', hex: 'hex', txt: 'text' }[ext] ?? 'text';
}

function codeBlock(name, caption) {
  const lang = langOf(name);
  const body = highlight(snippet(name), lang);
  const label = caption ?? '';
  return `<figure class="code">${label ? `<figcaption>${label}</figcaption>` : ''}<pre tabindex="0"><code class="language-${lang}">${body}</code></pre></figure>`;
}

// Inline code blocks: {{pre:lang}} … {{/pre}} inside fragments.
function inlineBlocks(html) {
  return html.replace(/\{\{pre:(\w+)(?:\|([^}]*))?\}\}\n?([\s\S]*?)\n?\{\{\/pre\}\}/g, (_, lang, caption, code) => {
    const body = highlight(code.replace(/\s+$/, ''), lang);
    return `<figure class="code">${caption ? `<figcaption>${caption}</figcaption>` : ''}<pre tabindex="0"><code class="language-${lang}">${body}</code></pre></figure>`;
  });
}

// ------------------------------------------------------------------ page assembly

const slug = (text) =>
  text
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .toLowerCase()
    .replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function addHeadingIds(html) {
  const used = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  return html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (m, level, text) => {
    let id = slug(text) || 'section';
    while (used.has(id)) id += '-2';
    used.add(id);
    return `<h${level} id="${id}">${text}</h${level}>`;
  });
}

function wrapTables(html) {
  return html.replace(/<table([^>]*)>([\s\S]*?)<\/table>/g, (m, attrs, inner) => {
    const label = attrs.match(/data-label="([^"]*)"/)?.[1] ?? inner.match(/<caption>([\s\S]*?)<\/caption>/)?.[1]?.replace(/<[^>]+>/g, '') ?? 'Table';
    const cleaned = attrs.replace(/\s*data-label="[^"]*"/, '');
    return `<div class="table-wrap" role="region" tabindex="0" aria-label="${attr(label.trim())}"><table${cleaned}>${inner}</table></div>`;
  });
}

function toc(html) {
  const items = [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
  if (items.length < 4) return '';
  return `<nav class="toc" aria-labelledby="toc-title"><h2 id="toc-title">On this page</h2><ul>${items
    .map(([, id, text]) => `<li><a href="#${id}">${text.replace(/<[^>]+>/g, '')}</a></li>`)
    .join('')}</ul></nav>`;
}

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect class="logo-bg" width="32" height="32" rx="8"/><circle class="logo-fg" cx="11" cy="8.6" r="2.3" stroke="none"/><circle class="logo-fg" cx="21" cy="8.6" r="2.3" stroke="none"/><path class="logo-fg" d="M10 13.6v6a6 6 0 0 0 12 0v-6" fill="none" stroke-width="3.2" stroke-linecap="round" style="fill:none"/></svg>`;

let absolute = false;
function rel(from, to) {
  // Relative URL from page `from` to site path `to` (both relative to the site root). Pages that
  // can be served from any path (404) use root-absolute URLs instead.
  if (absolute) return '/' + to;
  const depth = from.split('/').length - 1;
  return '../'.repeat(depth) + to;
}

function header(path) {
  const nav = TOP_NAV.map(([href, label, match]) => {
    const current = match ? match(path) : path === href;
    return `<li><a href="${rel(path, href)}"${current ? ' aria-current="page"' : ''}>${label}</a></li>`;
  }).join('');
  return `<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${rel(path, 'index.html')}" aria-label="apü home">${LOGO}<span>apü</span><span class="draft-tag">research draft</span></a>
    <nav class="site-nav" aria-label="Main"><ul>${nav}</ul></nav>
  </div>
</header>`;
}

function footer(path) {
  const r = (to) => rel(path, to);
  return `<footer class="site-footer">
  <div class="wrap">
    <div>
      <a class="brand" href="${r('index.html')}" aria-label="apü home">${LOGO}<span>apü</span></a>
      <p>An API protocol built on plain HTTP semantics. Research draft 01, October 2026 — not a stable standard, and no package is published yet.</p>
      <p>The name is written <strong>apü</strong>; URLs, headers and media types use <code>apue</code>.</p>
    </div>
    <nav aria-label="Footer: learn">
      <h2>Learn</h2>
      <ul>
        <li><a href="${r('docs/getting-started.html')}">Getting started</a></li>
        <li><a href="${r('docs/concepts.html')}">Operations &amp; HTTP mapping</a></li>
        <li><a href="${r('docs/streaming.html')}">Streaming</a></li>
        <li><a href="${r('docs/errors.html')}">Errors</a></li>
        <li><a href="${r('docs/manifest.html')}">Manifest &amp; codegen</a></li>
      </ul>
    </nav>
    <nav aria-label="Footer: reference">
      <h2>Reference</h2>
      <ul>
        <li><a href="${r('docs/server.html')}">Server reference</a></li>
        <li><a href="${r('docs/client.html')}">Client reference</a></li>
        <li><a href="${r('docs/wire-format.html')}">Wire format</a></li>
        <li><a href="${r('docs/measurements.html')}">Measurements</a></li>
        <li><a href="${r('docs/spec.html')}">Spec &amp; research</a></li>
      </ul>
    </nav>
  </div>
</footer>`;
}

function docNav(path) {
  const groups = DOCS.map(([group, items]) =>
    `<h2>${group}</h2><ul>${items
      .map(([href, label]) => `<li><a href="${rel(path, href)}"${href === path ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`)
      .join('')}</ul>`,
  ).join('');
  return {
    side: `<nav class="docnav" aria-label="Documentation">${groups}</nav>`,
    mobile: `<details class="docnav-mobile"><summary>Documentation menu</summary><nav class="inner" aria-label="Documentation (menu)">${groups}</nav></details>`,
  };
}

function pager(path) {
  const i = DOC_ORDER.findIndex(([href]) => href === path);
  if (i === -1) return '';
  const prev = DOC_ORDER[i - 1];
  const next = DOC_ORDER[i + 1];
  return `<nav class="pager" aria-label="Previous and next page">${
    prev ? `<a class="prev" href="${rel(path, prev[0])}" rel="prev"><span>Previous</span><b>${esc(prev[1])}</b></a>` : '<span></span>'
  }${next ? `<a class="next" href="${rel(path, next[0])}" rel="next"><span>Next</span><b>${esc(next[1])}</b></a>` : ''}</nav>`;
}

function head(meta, path) {
  const url = path === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${path}`;
  const title = meta.title;
  const ogTitle = meta.ogTitle ?? title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${attr(meta.description)}">
${meta.noindex ? '<meta name="robots" content="noindex">\n' : `<link rel="canonical" href="${url}">\n`}<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1016" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${rel(path, 'assets/favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${rel(path, 'assets/style.css')}">
<meta property="og:type" content="${path === 'index.html' ? 'website' : 'article'}">
<meta property="og:site_name" content="apü">
<meta property="og:locale" content="en">
<meta property="og:title" content="${attr(ogTitle)}">
<meta property="og:description" content="${attr(meta.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="apü — typed API operations on plain HTTP">
<meta name="twitter:card" content="summary_large_image">
</head>`;
}

function render(file) {
  const source = readFileSync(join(HERE, 'pages', file), 'utf8');
  const metaMatch = source.match(/^<!--(\{[\s\S]*?\})-->\n/);
  if (!metaMatch) throw new Error(`${file}: missing meta comment`);
  const meta = JSON.parse(metaMatch[1]);
  const path = meta.path;
  absolute = meta.absolute === true;
  let body = source.slice(metaMatch[0].length);
  body = body.replace(/\{\{code:([^|}]+)(?:\|([^}]*))?\}\}/g, (_, name, caption) => codeBlock(name.trim(), caption?.trim()));
  body = inlineBlocks(body);
  body = body.replace(/\{\{root\}\}/g, rel(path, ''));
  body = addHeadingIds(body);
  body = wrapTables(body);
  let main;
  if (meta.layout === 'docs') {
    const nav = docNav(path);
    body = body.replace('{{toc}}', toc(body));
    main = `<div class="wrap docs-layout">
${nav.side}
<main id="main" class="prose" tabindex="-1">
${nav.mobile}
${body}
${pager(path)}
</main>
</div>`;
  } else {
    main = `<main id="main" tabindex="-1">
${body}
</main>`;
  }
  const html = `${head(meta, path)}
<body>
${header(path)}
${main}
${footer(path)}
</body>
</html>
`;
  mkdirSync(dirname(join(SITE, path)), { recursive: true });
  writeFileSync(join(SITE, path), html);
  return { path, meta };
}

const pages = readdirSync(join(HERE, 'pages')).filter((f) => f.endsWith('.html')).map(render);

// sitemap.xml (404 excluded)
const lastmod = '2026-10-28';
const urls = pages
  .filter(({ meta }) => !meta.noindex)
  .map(({ path }) => (path === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${path}`))
  .sort((a, b) => (a === `${ORIGIN}/` ? -1 : b === `${ORIGIN}/` ? 1 : a.localeCompare(b)));
writeFileSync(
  join(SITE, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}
</urlset>
`,
);
console.log(`built ${pages.length} pages, ${urls.length} sitemap entries`);
