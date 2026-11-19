import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { cloudflareResolver } from './cloudflare-resolver.mjs';
import { distFiles, htmlPages, readJson } from './dist.mjs';
import { canonicalPath, excludedBy } from './excluded.mjs';
import { loadExceptions } from './exceptions.mjs';
import { hostResolver } from './host-resolver.mjs';
import { attr, byTag, find, findAll } from './html.mjs';

const ABSOLUTE = /^(?:https?:)?\/\//i;
const ROOT_RELATIVE = /^\/(?![\/\\])/;
const WORDPRESS_SERVICE = /^\/(?:wp-admin(?:\/|$)|wp-json(?:\/|$)|(?:xmlrpc|wp-(?:login|signup|activate|comments-post|cron|trackback|mail|links-opml))\.php(?:\/|$))/i;
const WORDPRESS_QUERY = ['s', 'rest_route', 'preview', 'preview_id', 'preview_nonce', 'replytocom', 'wc-ajax', 'add-to-cart'];
const bareHost = (url) => url.host.toLowerCase().replace(/^www\./, '');
const escapeAttr = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

function parseLink(href, base) {
  if (!ABSOLUTE.test(href)) return null;
  try {
    const url = new URL(href, base);
    if (!url.username && !url.password) return url;
  } catch {
    // Leave malformed hrefs for the links gate.
  }
  return null;
}

export function normalizeContentLinks(html, { origin, hosts, excluded, excepted, resolve, stored, wordpress = true }) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const body = find(document, byTag('body'));
  const head = find(document, byTag('head'));
  const base = find(head, (node) => node.tagName === 'base' && attr(node, 'href') !== null);
  const baseHref = attr(base, 'href')?.trim() ?? '';
  const links = findAll(body, (node) => node.tagName === 'a' || node.tagName === 'area');
  const edits = new Map();
  let preserved = 0;
  for (const link of links) {
    const href = attr(link, 'href')?.trim();
    const location = link.sourceCodeLocation?.attrs?.href;
    if (!href || !location) continue;
    const url = parseLink(href, origin);
    if (!url || !hosts.has(bareHost(url))) continue;
    const path = canonicalPath(url.pathname);
    const target = url.href.slice(url.origin.length);
    const wpService = wordpress && (WORDPRESS_SERVICE.test(path) || WORDPRESS_QUERY.some((key) => url.searchParams.has(key)));
    if (!ROOT_RELATIVE.test(target) || excludedBy(excluded, path) || excepted.has(href) || wpService) {
      preserved++;
      continue;
    }
    // Empty origins in the resolver keep even an absolute redirect to production off the
    // list of preview destinations. A WP shortlink must resolve through a real query rule.
    const answer = resolve(`${url.pathname}${url.search}`);
    const shortlink = wordpress && path === '/' && ['p', 'page_id'].some((key) => url.searchParams.has(key));
    const localHop = answer.hops.length === 1 && ROOT_RELATIVE.test(answer.hops[0].to);
    const local = answer.final.status === 200 && (answer.hops.length === 0 || localHop);
    if (shortlink ? !local || !localHop : !local && !stored.has(path)) {
      preserved++;
      continue;
    }
    edits.set(location.startOffset, { ...location, href: target });
  }

  // Resolve the first effective base against a preview origin, including browser URL
  // handling for backslashes. A root-relative base is safe on every deployment.
  const preview = 'https://preview.invalid';
  let offSiteBase = false;
  if (edits.size && baseHref) {
    try {
      offSiteBase = new URL(baseHref, preview).origin !== preview;
    } catch {
      // An invalid base is ignored by browsers.
    }
  }
  if (offSiteBase) return { html, changed: 0, preserved: preserved + edits.size, offSiteBase };

  const parts = [];
  let offset = 0;
  for (const { startOffset, endOffset, href } of [...edits.values()].sort((a, b) => a.startOffset - b.startOffset)) {
    parts.push(html.slice(offset, startOffset), `href="${escapeAttr(href)}"`);
    offset = endOffset;
  }
  return { html: parts.join('') + html.slice(offset), changed: edits.size, preserved, offSiteBase };
}

export function storedMedia(site, baseline) {
  const planFile = join(site, 'docs/media-plan.json');
  const manifestFile = join(site, 'media-manifest.json');
  if (!existsSync(planFile) || !existsSync(manifestFile)) return new Set();
  const plan = readJson(planFile);
  if (plan.mode !== 'store' || !plan.prefix) return new Set();
  const media = new Map(readJson(join(baseline, 'media.json')).filter((item) => item.downloaded !== false)
    .map((item) => [canonicalPath(item.path), item.bytes]));
  return new Set(readJson(manifestFile).filter(({ path, bytes }) => excludedBy([plan.prefix], path)
    && Number.isFinite(bytes) && media.get(canonicalPath(path)) === bytes).map(({ path }) => canonicalPath(path)));
}

export function navigationResolver({ site, dist, host }) {
  const config = host === 'vercel' ? join(site, 'vercel.json') : join(dist, '_redirects');
  return host === 'cloudflare' && !existsSync(config)
    ? cloudflareResolver({ dist }) : hostResolver({ host, config, dist });
}

export function normalizeBuiltLinks({ site, dist, host, logger = console }) {
  const baseline = join(site, 'baseline');
  // The initial scaffold has no capture baseline yet.
  if (!existsSync(baseline)) return;
  const meta = readJson(join(baseline, 'meta.json'));
  const origins = [meta.origin, meta.canonicalOrigin].filter(Boolean).map((value) => new URL(value));
  if (!origins.length) throw new Error('baseline/meta.json is missing the captured origin');
  const hosts = new Set(origins.map(bareHost));
  const resolve = navigationResolver({ site, dist, host });
  const stored = storedMedia(site, baseline);
  const exceptions = loadExceptions(undefined, { cwd: site });
  const exceptedByPage = new Map();
  for (const { field, path, to } of exceptions) {
    if (field !== 'link') continue;
    if (!exceptedByPage.has(path)) exceptedByPage.set(path, new Set());
    exceptedByPage.get(path).add(to);
  }
  let changed = 0;
  let changedPages = 0;
  let preserved = 0;
  const pages = htmlPages(distFiles(dist));
  for (const { path, file } of pages) {
    const full = join(dist, file);
    const result = normalizeContentLinks(readFileSync(full, 'utf8'), {
      origin: origins.at(-1), hosts, excluded: meta.excluded, excepted: exceptedByPage.get(path) ?? new Set(),
      resolve, stored, wordpress: meta.platform == null || meta.platform === 'wordpress',
    });
    if (result.offSiteBase) logger.warn(`${path}: absolute <base href> keeps same-site links on their original URLs`);
    preserved += result.preserved;
    if (result.changed) {
      writeFileSync(full, result.html);
      changed += result.changed;
      changedPages++;
    }
  }
  logger.info(`Normalized ${changed} same-site links on ${changedPages}/${pages.length} pages. Preserved ${preserved} same-site absolute links.`);
}

export function contentLinkNormalization(host) {
  let site;
  return {
    name: 'normalize-content-links',
    hooks: {
      'astro:config:done': ({ config }) => { site = fileURLToPath(config.root); },
      'astro:build:done': ({ dir, logger }) => normalizeBuiltLinks({ site, dist: fileURLToPath(dir), host, logger }),
    },
  };
}
