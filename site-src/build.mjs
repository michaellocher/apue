// Builds site/ from page fragments (pages/*.html), code snippets (landing/, hello/, docs/ — they
// typecheck with the repo: `npm run typecheck`), the problem types (problems.mjs) and assets/.
// `node site-src/build.mjs`, then `node site-src/check.mjs` (links, anchors, metadata, contrast).
// The output is plain static HTML; site.js only enhances it (tabs, copy buttons, TOC highlight).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROBLEMS } from './problems.mjs';

const HERE = import.meta.dirname;
const SITE = join(HERE, '..', 'site');
const ORIGIN = 'https://apue.dev';
const GITHUB = 'https://github.com/michaellocher/apue';

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
    ['problems/index.html', 'Problem types'],
  ]],
  ['Background', [
    ['docs/measurements.html', 'Measurements'],
    ['docs/spec.html', 'Spec & research'],
  ]],
];
const DOC_ORDER = DOCS.flatMap(([, items]) => items);

const OWN_NAV = ['docs/wire-format.html', 'docs/measurements.html', 'docs/spec.html'];
const TOP_NAV = [
  ['docs/index.html', 'Docs', (p) => (p.startsWith('docs/') || p.startsWith('problems/')) && !OWN_NAV.includes(p)],
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
  if (lang === 'text' || lang === 'hex') return esc(code);
  if (lang === 'http') return highlightHttp(code);
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
  return esc(code)
    .replace(/"((?:[^"\\]|\\.)*)"(\s*:)?/g, (m, body, colon) => (colon ? `<span class="tok-k">"${body}"</span>${colon}` : `<span class="tok-s">"${body}"</span>`))
    .replace(/(:\s*|\[\s*|,\s*)(-?\d+(?:\.\d+)?|true|false|null)\b/g, (m, pre, value) => `${pre}<span class="tok-n">${value}</span>`);
}

// An HTTP response: status line, header fields, blank line, JSON body.
function highlightHttp(code) {
  const split = code.indexOf('\n\n');
  const head = split === -1 ? code : code.slice(0, split);
  const body = split === -1 ? '' : code.slice(split + 2);
  const lines = head.split('\n').map((line, i) => {
    if (i === 0) return `<span class="tok-k">${esc(line)}</span>`;
    const colon = line.indexOf(':');
    return colon === -1 ? esc(line) : `<span class="tok-c">${esc(line.slice(0, colon + 1))}</span>${esc(line.slice(colon + 1))}`;
  });
  return lines.join('\n') + (split === -1 ? '' : '\n\n' + highlightJson(body));
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

const figure = (body, lang, caption) =>
  `<figure class="code">${caption ? `<figcaption>${caption}</figcaption>` : ''}<pre tabindex="0"><code class="language-${lang}">${body}</code></pre></figure>`;

function codeBlock(name, caption) {
  const lang = langOf(name);
  return figure(highlight(snippet(name), lang), lang, caption ?? '');
}

// Inline code blocks: {{pre:lang}} … {{/pre}} inside fragments.
function inlineBlocks(html) {
  return html.replace(/\{\{pre:(\w+)(?:\|([^}]*))?\}\}\n?([\s\S]*?)\n?\{\{\/pre\}\}/g, (_, lang, caption, code) =>
    figure(highlight(code.replace(/\s+$/, ''), lang), lang, caption),
  );
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

// "On this page": once inside the content (narrow screens) and once in the right rail (wide
// screens); CSS shows exactly one of them.
function tocItems(html) {
  return [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
}
function toc(items, id) {
  return `<nav class="toc" aria-labelledby="${id}"><h2 id="${id}">On this page</h2><ul>${items
    .map(([, href, text]) => `<li><a href="#${href}">${text.replace(/<[^>]+>/g, '')}</a></li>`)
    .join('')}</ul></nav>`;
}

// The wordmark: geometric monoline "apü"; the umlaut is the two ends of a stream.
const WORDMARK = `<svg class="wordmark" viewBox="0 0 70 43" aria-hidden="true" focusable="false"><g class="wm-ink" fill="none" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="22" r="7.5"/><path d="M17.5 14.5v15"/><circle cx="35" cy="22" r="7.5"/><path d="M27.5 14.5v25M51.5 14.5V22a7.5 7.5 0 0 0 15 0v-7.5M66.5 22v7.5"/></g><circle class="wm-dot-a" cx="51.5" cy="4.6" r="3.1"/><circle class="wm-dot-b" cx="66.5" cy="4.6" r="3.1"/></svg>`;

const GH_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor"><path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/></svg>`;

let absolute = false;
function rel(from, to) {
  // Relative URL from page `from` to site path `to` (both relative to the site root). Pages that
  // can be served from more than one path (404, problem types) use root-absolute URLs instead.
  if (absolute) return '/' + to.replace(/(^|\/)index\.html$/, '$1');
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
    <a class="brand" href="${rel(path, 'index.html')}" aria-label="apü home">${WORDMARK}<span class="draft-tag">draft 01</span></a>
    <nav class="site-nav" aria-label="Main"><ul>${nav}<li><a class="nav-gh" href="${GITHUB}">${GH_ICON}GitHub <span class="tag tag-planned">private beta</span></a></li></ul></nav>
  </div>
</header>`;
}

function footer(path) {
  const r = (to) => rel(path, to);
  return `<footer class="site-footer">
  <div class="wrap">
    <div>
      <a class="brand" href="${r('index.html')}" aria-label="apü home">${WORDMARK}</a>
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
        <li><a href="${r('problems/index.html')}">Problem types</a></li>
      </ul>
    </nav>
    <nav aria-label="Footer: project">
      <h2>Project</h2>
      <ul>
        <li><a href="${r('docs/spec.html')}">Spec &amp; research</a></li>
        <li><a href="${r('docs/measurements.html')}">Measurements</a></li>
        <li><a href="${GITHUB}">GitHub (private beta)</a></li>
      </ul>
    </nav>
  </div>
</footer>`;
}

function docNav(path, current) {
  const groups = DOCS.map(([group, items]) =>
    `<h2>${group}</h2><ul>${items
      .map(([href, label]) => `<li><a href="${rel(path, href)}"${href === current ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`)
      .join('')}</ul>`,
  ).join('');
  return {
    side: `<nav class="docnav" aria-label="Documentation">${groups}</nav>`,
    mobile: `<details class="docnav-mobile"><summary>Documentation menu</summary><nav class="inner" aria-label="Documentation (menu)">${groups}</nav></details>`,
  };
}

function pagerLinks(path, prev, next, label = 'Previous and next page') {
  return `<nav class="pager" aria-label="${label}">${
    prev ? `<a class="prev" href="${rel(path, prev[0])}" rel="prev"><span>Previous</span><b>${esc(prev[1])}</b></a>` : ''
  }${next ? `<a class="next" href="${rel(path, next[0])}" rel="next"><span>Next</span><b>${esc(next[1])}</b></a>` : ''}</nav>`;
}

function pager(path) {
  const i = DOC_ORDER.findIndex(([href]) => href === path);
  if (i === -1) return '';
  return pagerLinks(path, DOC_ORDER[i - 1], DOC_ORDER[i + 1]);
}

// Canonical URL of a site file: problem types live at their type URI (no .html).
function canonical(path) {
  if (path === 'index.html') return `${ORIGIN}/`;
  if (path.endsWith('/index.html')) return `${ORIGIN}/${path.slice(0, -'index.html'.length)}`;
  const problem = path.match(/^problems\/([a-z-]+)\.html$/);
  if (problem) return `${ORIGIN}/problems/${problem[1]}`;
  return `${ORIGIN}/${path}`;
}

function head(meta, path) {
  const url = meta.canonical ?? canonical(path);
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
<meta name="theme-color" content="#090b14" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${rel(path, 'assets/favicon.svg')}" type="image/svg+xml">
<link rel="stylesheet" href="${rel(path, 'assets/style.css')}">
<script src="${rel(path, 'assets/site.js')}" defer></script>
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

function expand(body, path) {
  body = body.replace(/\{\{code:([^|}]+)(?:\|([^}]*))?\}\}/g, (_, name, caption) => codeBlock(name.trim(), caption?.trim()));
  body = inlineBlocks(body);
  body = body.replace(/\{\{root\}\}/g, rel(path, ''));
  body = addHeadingIds(body);
  return wrapTables(body);
}

function docsMain(path, body, { navCurrent = path, pagerHtml = pager(path) } = {}) {
  const nav = docNav(path, navCurrent);
  const items = tocItems(body);
  const hasToc = items.length >= 4 && body.includes('{{toc}}');
  body = body.replace('{{toc}}', hasToc ? toc(items, 'toc-title') : '');
  return `<div class="wrap docs-layout${hasToc ? ' has-toc' : ''}">
${nav.side}
<main id="main" class="prose" tabindex="-1">
${nav.mobile}
${body}
${pagerHtml}
</main>
${hasToc ? `<aside class="toc-rail">${toc(items, 'toc-rail-title')}</aside>\n` : ''}</div>`;
}

function writePage(path, meta, main) {
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
  return Buffer.byteLength(html);
}

function render(file) {
  const source = readFileSync(join(HERE, 'pages', file), 'utf8');
  const metaMatch = source.match(/^<!--(\{[\s\S]*?\})-->\n/);
  if (!metaMatch) throw new Error(`${file}: missing meta comment`);
  const meta = JSON.parse(metaMatch[1]);
  const path = meta.path;
  absolute = meta.absolute === true;
  const body = expand(source.slice(metaMatch[0].length), path);
  const main = meta.layout === 'docs' ? docsMain(path, body) : `<main id="main" tabindex="-1">\n${body}\n</main>`;
  writePage(path, meta, main);
  return { path, meta };
}

// ------------------------------------------------------------------ problem types

const statusList = (p) => p.statuses.map(([code]) => code).join(' · ');

function problemPage(p, i) {
  absolute = true; // served as /problems/<name>, /problems/<name>.html and /problems/<name>/
  const uri = `${ORIGIN}/problems/${p.name}`;
  const path = `problems/${p.name}.html`;
  const prev = PROBLEMS[i - 1];
  const next = PROBLEMS[i + 1];
  const members = [['type', `<code>${uri}</code>`], ['title', `<code>${esc(p.title)}</code>, the same for every occurrence of this type.`], ['status', p.statuses.map(([c, where]) => `<code>${c}</code> (${where})`).join(', ')], ['detail', 'A human-readable explanation of this occurrence; don’t parse it.'], ...p.members];
  let body = `<p class="breadcrumb"><a href="${rel(path, 'docs/index.html')}">Docs</a> / <a href="${rel(path, 'problems/index.html')}">Problem types</a></p>
<div class="problem-head">${p.statuses.map(([code]) => `<span class="status-pill${code.startsWith('5') ? ' s5' : ''}">${code}</span>`).join('')}<span class="tag tag-accent">application/problem+json</span></div>
<h1>${esc(p.title)}</h1>
<p class="page-intro">${esc(p.summary)}</p>
<p class="type-uri"><span>Type URI</span><code>${uri}</code></p>
<h2>When it happens</h2>
${p.when}
<h2>Members</h2>
<p>An RFC 9457 problem details object. Besides the standard members it may carry:</p>
<dl class="facts">${members.map(([k, v]) => `<dt><code>${k}</code></dt><dd>${v}</dd>`).join('')}</dl>
<h2>Example</h2>
${p.examples.map((e) => figure(highlight(e.code, e.lang), e.lang, esc(e.caption))).join('\n')}
<h2>How clients should react</h2>
<ul>${p.react.map((r) => `<li>${r}</li>`).join('')}</ul>
<p class="source">Raised in ${esc(p.source)} of the reference implementation. See also: ${p.related.map(([href, label]) => `<a href="${rel(path, href)}">${esc(label)}</a>`).join(', ')}, <a href="${rel(path, 'docs/errors.html')}">Errors</a>.</p>`;
  body = expand(body, path);
  const main = docsMain(path, body, {
    navCurrent: 'problems/index.html',
    pagerHtml: pagerLinks(path, prev && [`problems/${prev.name}.html`, prev.name], next && [`problems/${next.name}.html`, next.name], 'Previous and next problem type'),
  });
  const meta = {
    canonical: uri,
    title: `${p.title} (${statusList(p)}) — apü problem type`,
    description: `The apü problem type ${uri}: ${p.summary} Status ${statusList(p)}, when it happens, its members, an example and how clients should react.`,
  };
  // The same document under both file names, so the type URI resolves on any static host.
  writePage(path, meta, main);
  writePage(`problems/${p.name}/index.html`, meta, main);
  return { path, meta };
}

function problemIndex() {
  absolute = true;
  const path = 'problems/index.html';
  let body = `<p class="breadcrumb"><a href="${rel(path, 'docs/index.html')}">Docs</a> / Reference</p>
<h1>Problem types</h1>
<p class="page-intro">apü errors are real HTTP status codes with RFC 9457 problem details. Its own protocol errors have a <code>type</code> under <code>https://apue.dev/problems/</code>; each of those URIs resolves to its page here.</p>
<ul class="ptypes">${PROBLEMS.map((p) => `<li><a href="${rel(path, `problems/${p.name}.html`)}"><span class="st">${p.statuses.map(([code]) => code).join('<br>')}</span><b>${p.name}</b><span>${esc(p.summary)}</span></a></li>`).join('')}</ul>
<h2>Generic errors</h2>
<p>Everything else uses the type <code>about:blank</code> with the HTTP status phrase as <code>title</code> — for example <code>405 Method Not Allowed</code> (with an <code>Allow</code> header), <code>408</code> when a request body doesn’t arrive in time, <code>413</code> beyond the size limits, <code>415</code> for a wrong content type, <code>429</code>/<code>503</code> (retried by clients, honouring <code>Retry-After</code>). Unexpected handler errors are a <code>500</code> without details. Errors your handlers throw can use types of your own.</p>
<h2>Extension members</h2>
<dl class="facts"><dt><code>retryable</code></dt><dd>Boolean: repeating the same request later may succeed (e.g. <a href="${rel(path, 'problems/idempotency-key-in-progress.html')}">idempotency-key-in-progress</a>, or a <code>503</code> while a server shuts down).</dd><dt><code>fields</code></dt><dd>Per-field validation errors, <code>[{ path, message }]</code> (<a href="${rel(path, 'problems/validation-failed.html')}">validation-failed</a>).</dd></dl>
<p>Where problems travel — responses, END frames of streams and batch lanes — is described in <a href="${rel(path, 'docs/errors.html')}">Errors</a>.</p>`;
  body = expand(body, path);
  const meta = {
    title: 'Problem types — apü',
    description: 'The apü problem types under https://apue.dev/problems/: status codes, when each one happens, extension members and how clients should react.',
  };
  writePage(path, meta, docsMain(path, body));
  return { path, meta };
}

// ------------------------------------------------------------------ build

mkdirSync(join(SITE, 'assets'), { recursive: true });
for (const asset of ['style.css', 'site.js', 'favicon.svg']) copyFileSync(join(HERE, 'assets', asset), join(SITE, 'assets', asset));

const pages = readdirSync(join(HERE, 'pages')).filter((f) => f.endsWith('.html')).map(render);
pages.push(problemIndex(), ...PROBLEMS.map(problemPage));

// sitemap.xml (404 excluded; problem types under their type URI)
const lastmod = '2026-10-28';
const urls = pages
  .filter(({ meta }) => !meta.noindex)
  .map(({ path }) => canonical(path))
  .sort((a, b) => (a === `${ORIGIN}/` ? -1 : b === `${ORIGIN}/` ? 1 : a.localeCompare(b)));
writeFileSync(
  join(SITE, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}
</urlset>
`,
);
console.log(`built ${pages.length} pages (+${PROBLEMS.length} problem-type aliases), ${urls.length} sitemap entries`);
