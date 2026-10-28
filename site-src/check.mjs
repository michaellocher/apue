// Static checks for site/: internal links and anchors, asset references, external URLs, required
// head metadata, landmarks, sitemap, and WCAG contrast of the colour tokens.
//   node check.mjs [/path/to/site]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, posix } from 'node:path';

const SITE = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'site'));
const ORIGIN = 'https://apue.dev';
const errors = [];
const warn = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(SITE).map((p) => relative(SITE, p).split('\\').join('/'));
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// ids per page
const ids = new Map();
const sources = new Map();
for (const file of htmlFiles) {
  const html = readFileSync(join(SITE, file), 'utf8');
  sources.set(file, html);
  const list = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  for (const id of list) {
    if (seen.has(id)) fail(file, `duplicate id "${id}"`);
    seen.add(id);
  }
  ids.set(file, seen);
}

const external = new Map(); // url -> Set(files) (attribute values)
const externalText = new Map(); // urls only mentioned in text/code
let internalChecked = 0;

function resolveTarget(file, url) {
  // Returns the site-relative file a URL points to (or undefined for external/special).
  if (url.startsWith('/')) return url.slice(1);
  return posix.normalize(posix.join(posix.dirname(file), url));
}

for (const file of htmlFiles) {
  const html = sources.get(file);
  // --- head metadata
  if (!/<html lang="en">/.test(html)) fail(file, 'missing <html lang="en">');
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  if (!title || title.trim().length < 5) fail(file, 'missing/short <title>');
  const desc = html.match(/<meta name="description" content="([^"]+)">/)?.[1];
  if (!desc || desc.length < 50) fail(file, 'missing/short meta description');
  if (desc && desc.length > 300) warn.push(`${file}: description is ${desc.length} chars`);
  if (!/<meta name="viewport"/.test(html)) fail(file, 'missing viewport');
  if (!/<meta charset="utf-8">/.test(html)) fail(file, 'missing charset');
  for (const prop of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type', 'og:site_name']) {
    if (!html.includes(`property="${prop}"`)) fail(file, `missing ${prop}`);
  }
  const ogUrl = html.match(/property="og:url" content="([^"]+)"/)?.[1];
  const expected = file === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${file}`;
  if (ogUrl !== expected) fail(file, `og:url ${ogUrl} ≠ ${expected}`);
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
  if (file !== '404.html' && canonical !== expected) fail(file, `canonical ${canonical} ≠ ${expected}`);
  if (!/<link rel="icon" href="[^"]+favicon\.svg"/.test(html)) fail(file, 'missing favicon link');
  // --- structure / accessibility
  const h1s = (html.match(/<h1[\s>]/g) ?? []).length;
  if (h1s !== 1) fail(file, `${h1s} <h1> elements`);
  if (!/<main id="main"/.test(html)) fail(file, 'missing <main id="main">');
  if (!/<a class="skip-link" href="#main">/.test(html)) fail(file, 'missing skip link');
  if (!/<header class="site-header">/.test(html) || !/<footer class="site-footer">/.test(html)) fail(file, 'missing header/footer landmark');
  if (/<script\b/i.test(html)) fail(file, 'contains a <script> (none expected)');
  if (/\sstyle="[^"]*url\(/.test(html)) fail(file, 'inline style with url()');
  for (const m of html.matchAll(/<img\b[^>]*>/g)) if (!/\salt="/.test(m[0])) fail(file, `img without alt: ${m[0]}`);
  // heading levels never skip (h2 → h4)
  let last = 1;
  for (const m of html.matchAll(/<h([1-6])[\s>]/g)) {
    const level = Number(m[1]);
    if (level > last + 1) fail(file, `heading level jumps from h${last} to h${level}`);
    last = level;
  }
  // nav landmarks need distinct labels
  const navLabels = [...html.matchAll(/<nav[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
  const dup = navLabels.filter((l, i) => navLabels.indexOf(l) !== i);
  if (dup.length) fail(file, `duplicate nav labels: ${dup.join(', ')}`);
  for (const m of html.matchAll(/<nav(?![^>]*aria-label)(?![^>]*aria-labelledby)[^>]*>/g)) fail(file, `nav without label: ${m[0]}`);

  // --- links and references
  for (const m of html.matchAll(/\s(href|src|srcset|action|content)="([^"]*)"/g)) {
    const [, attr, raw] = m;
    const url = decode(raw);
    if (attr === 'content') {
      if (/^https?:\/\//.test(url)) {
        if (!url.startsWith(`${ORIGIN}/`)) fail(file, `meta content points off-site: ${url}`);
        else {
          // own-origin metadata URLs must exist in site/
          const path = url.slice(ORIGIN.length + 1) || 'index.html';
          if (!files.includes(path)) fail(file, `meta URL ${url} has no file ${path}`);
          (external.get(url) ?? external.set(url, new Set()).get(url)).add(file);
        }
      }
      continue;
    }
    if (/^(https?:)?\/\//.test(url)) {
      (external.get(url) ?? external.set(url, new Set()).get(url)).add(file);
      continue;
    }
    if (/^(mailto|tel|data|javascript):/.test(url)) {
      fail(file, `unexpected ${url.split(':')[0]}: URL`);
      continue;
    }
    internalChecked++;
    const [pathPart, hash] = url.split('#');
    const target = pathPart === '' ? file : resolveTarget(file, pathPart);
    if (target.startsWith('..')) {
      fail(file, `link leaves the site: ${url}`);
      continue;
    }
    if (!files.includes(target)) {
      fail(file, `broken link ${url} → ${target}`);
      continue;
    }
    if (hash !== undefined) {
      if (!target.endsWith('.html')) fail(file, `anchor on non-HTML ${url}`);
      else if (!ids.get(target)?.has(hash)) fail(file, `missing anchor #${hash} in ${target} (${url})`);
    }
  }
  // URLs mentioned in text and code (not requests; listed for review)
  const text = html.replace(/<head>[\s\S]*?<\/head>/, '').replace(/\s(href|src|content)="[^"]*"/g, '');
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)`\\]+/g)) {
    const u = m[0].replace(/[.,;:]+$/, '');
    (externalText.get(u) ?? externalText.set(u, new Set()).get(u)).add(file);
  }
}

// --- CSS: no external requests, url() targets exist
for (const file of files.filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(join(SITE, file), 'utf8');
  if (/@import/.test(css)) fail(file, '@import found');
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) {
    const u = m[1].replace(/['"]/g, '');
    if (/^(https?:)?\/\//.test(u)) fail(file, `external url() ${u}`);
    else if (!u.startsWith('data:') && !files.includes(resolveTarget(file, u))) fail(file, `missing url() target ${u}`);
  }
  if (/font-face/.test(css)) warn.push(`${file}: @font-face present`);
}
// --- SVG: no external references
for (const file of files.filter((f) => f.endsWith('.svg'))) {
  const svg = readFileSync(join(SITE, file), 'utf8');
  if (/(href|src)="(https?:)?\/\//.test(svg)) fail(file, 'external reference in SVG');
}

// --- sitemap and robots
const sitemap = readFileSync(join(SITE, 'sitemap.xml'), 'utf8');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
for (const loc of locs) {
  const path = loc.slice(ORIGIN.length + 1) || 'index.html';
  if (!loc.startsWith(`${ORIGIN}/`) || !files.includes(path)) fail('sitemap.xml', `bad <loc> ${loc}`);
}
for (const file of htmlFiles) {
  const url = file === 'index.html' ? `${ORIGIN}/` : `${ORIGIN}/${file}`;
  if (file !== '404.html' && !locs.includes(url)) fail('sitemap.xml', `missing ${url}`);
}
if (locs.includes(`${ORIGIN}/404.html`)) fail('sitemap.xml', '404 listed');
const robots = readFileSync(join(SITE, 'robots.txt'), 'utf8');
if (!robots.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)) fail('robots.txt', 'no Sitemap line');
if (!files.includes('404.html')) fail('site', 'no 404.html');

// --- contrast of colour tokens (WCAG 2.x relative luminance)
const css = readFileSync(join(SITE, 'assets/style.css'), 'utf8');
function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}
const light = tokens(css.match(/:root\s*\{([\s\S]*?)\n\}/)[1]);
const dark = { ...light, ...tokens(css.match(/prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n  \}/)[1]) };
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const pairs = [
  ['fg', 'bg', 4.5], ['fg-muted', 'bg', 4.5], ['fg-muted', 'bg-soft', 4.5], ['fg', 'bg-code', 4.5], ['fg-muted', 'bg-code', 4.5],
  ['link', 'bg', 4.5], ['link', 'bg-soft', 4.5], ['link', 'bg-raised', 4.5], ['accent-fg', 'accent', 4.5], ['accent-fg', 'accent-hover', 4.5],
  ['accent', 'bg', 3], ['accent', 'bg-raised', 4.5], ['ok', 'ok-soft', 4.5], ['planned', 'planned-soft', 4.5],
  ['tok-comment', 'bg-code', 4.5], ['tok-string', 'bg-code', 4.5], ['tok-keyword', 'bg-code', 4.5], ['tok-number', 'bg-code', 4.5], ['tok-prompt', 'bg-code', 4.5],
  ['fg', 'accent-soft', 4.5], ['link', 'accent-soft', 4.5], ['fg-muted', 'bg-raised', 4.5], ['focus', 'bg', 3], ['border-strong', 'bg', 1.4],
];
const contrast = [];
for (const [scheme, t] of [['light', light], ['dark', dark]]) {
  for (const [fg, bg, min] of pairs) {
    const r = ratio(t[fg], t[bg]);
    contrast.push(`${scheme.padEnd(5)} ${fg} on ${bg}: ${r.toFixed(2)}${r < min ? `  < ${min} FAIL` : ''}`);
    if (r < min) fail('style.css', `${scheme}: ${fg} on ${bg} = ${r.toFixed(2)} < ${min}`);
  }
}

console.log(`files: ${files.length} (${htmlFiles.length} HTML); internal references checked: ${internalChecked}`);
console.log('\nExternal URLs in attributes (requests or links):');
for (const [u, f] of [...external].sort()) console.log(`  ${u}  [${[...f].length} file(s)]`);
console.log('\nURLs mentioned in text/code only (not fetched):');
for (const [u, f] of [...externalText].sort()) console.log(`  ${u}  [${[...f].join(', ')}]`);
console.log('\nContrast:');
for (const line of contrast) console.log('  ' + line);
if (warn.length) console.log('\nWarnings:\n  ' + warn.join('\n  '));
if (errors.length) {
  console.log(`\n${errors.length} ERROR(S):\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log('\nOK: no errors');
