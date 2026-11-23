// Astro build integration. Only the WebP source is new; the captured img remains the fallback.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import sharp from 'sharp';
import { distFiles, htmlPages } from './lib/dist.mjs';
import { attr, findAll, walk } from './lib/html.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escapeAttr = (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const activePhases = new Set(['performance', 'prelaunch', 'suggestions', 'pr']);

function imageFile(raw, base, files) {
  try {
    const url = new URL(raw, base);
    if (url.origin !== base.origin || url.search || url.hash || !/\.(?:png|jpe?g)$/i.test(url.pathname)) return null;
    const file = decodeURIComponent(url.pathname).slice(1);
    return files.has(file) ? file : null;
  } catch {
    return null;
  }
}

function candidates(img) {
  const srcset = attr(img, 'srcset');
  if (!srcset) return [{ url: attr(img, 'src'), descriptor: '' }];
  // Preserve width choices. Density sets, data URLs and nonstandard syntax stay intact.
  const entries = srcset.split(',').map((entry) => /^(\S+)\s+([1-9]\d*w)$/.exec(entry.trim()));
  return entries.every(Boolean) ? entries.map(([, url, descriptor]) => ({ url, descriptor })) : [];
}

function pageImages(doc) {
  const imgs = [];
  walk(doc, (node) => {
    if (['picture', 'template', 'noscript', 'svg'].includes(node.tagName)) return false;
    if (node.tagName === 'img') imgs.push(node);
  });
  return imgs;
}

function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

async function trial(dist, cache, file) {
  const input = readFileSync(join(dist, file));
  const record = { file, originalBytes: input.length, originalHash: digest(input) };
  const key = digest(JSON.stringify([record.originalHash, sharp.versions, 'png-lossless/jpeg-q85-v1']));
  const receipt = join(cache, key + '.json');
  const candidate = join(cache, key + '.webp');
  if (existsSync(receipt)) {
    const saved = JSON.parse(readFileSync(receipt, 'utf8'));
    if (saved.originalHash === record.originalHash && saved.reason === 'original is smaller or equal') return { ...saved, file };
    if (saved.url === `/_astro/converted-images/${saved.hash}.webp` && existsSync(candidate)
      && digest(readFileSync(candidate)) === saved.hash) return { ...saved, file, candidate };
  }
  let output;
  try {
    const image = sharp(input);
    const meta = await image.metadata();
    if (!['png', 'jpeg'].includes(meta.format) || meta.hasProfile || meta.space !== 'srgb'
      || (meta.orientation ?? 1) !== 1 || (meta.pages ?? 1) !== 1) {
      return { ...record, reason: 'format, animation, orientation or colour profile' };
    }
    record.width = meta.width;
    record.height = meta.height;
    output = await image.webp(meta.format === 'png' ? { lossless: true } : { quality: 85 }).toBuffer();
  } catch (error) {
    return { ...record, reason: `encoder: ${error.message}` };
  }
  record.candidateBytes = output.length;
  if (output.length >= input.length) {
    record.reason = 'original is smaller or equal';
  } else {
    record.hash = digest(output);
    record.url = `/_astro/converted-images/${record.hash}.webp`;
    atomicWrite(candidate, output);
  }
  atomicWrite(receipt, JSON.stringify(record));
  return { ...record, candidate };
}

export async function optimizeImages({ site, dist, origin, exclude = [] }) {
  const files = new Set(distFiles(dist));
  const cache = join(site, '.astro', 'converted-images');
  const trials = new Map();
  const pages = {};
  let scanned = 0;
  let rewritten = 0;
  for (const { path, file } of htmlPages([...files])) {
    const page = join(dist, file);
    const html = readFileSync(page, 'utf8');
    const doc = parse(html, { sourceCodeLocationInfo: true });
    // File-format /about.html is served at /about; both resolve a relative image beside it.
    const base = new URL(file.endsWith('/index.html') ? path : '/' + file, origin);
    const imgs = pageImages(doc);
    scanned += imgs.length;
    if (findAll(doc, (n) => n.tagName === 'base' && attr(n, 'href') !== null).length) continue;
    const preload = new Set();
    for (const link of findAll(doc, (n) => n.tagName === 'link' && attr(n, 'as') === 'image')) {
      const urls = (attr(link, 'imagesrcset') || '').split(',').map((entry) => entry.trim().split(/\s+/)[0]);
      for (const url of [attr(link, 'href'), ...urls]) preload.add(imageFile(url, base, files));
    }
    const edits = [];
    for (const img of imgs) {
      if (!attr(img, 'src') || img.attrs.some(({ name }) => /^(?:data-|on|usemap$|ismap$)/.test(name))) continue;
      const sources = candidates(img);
      const fallback = imageFile(attr(img, 'src'), base, files);
      const inputs = sources.map(({ url }) => imageFile(url, base, files));
      if (!fallback || !inputs.length || [fallback, ...inputs].some((f) => !f || preload.has(f) || exclude.includes('/' + f))) continue;
      for (const input of inputs) {
        if (!trials.has(input)) trials.set(input, await trial(dist, cache, input));
      }
      const records = inputs.map((input) => trials.get(input));
      if (records.some((r, i) => !r.url || (sources[i].descriptor && r.width !== parseInt(sources[i].descriptor, 10)))) continue;
      const srcset = records.map((r, i) => [r.url, sources[i].descriptor].filter(Boolean).join(' ')).join(', ');
      const sizes = attr(img, 'sizes');
      const tag = `<picture><source type="image/webp" srcset="${srcset}"${sizes ? ` sizes="${escapeAttr(sizes)}"` : ''}>`;
      const { startOffset, endOffset } = img.sourceCodeLocation;
      edits.push({ startOffset, endOffset, tag });
      for (const r of records) {
        if (!r.served) {
          const destination = join(dist, r.url);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(r.candidate, destination);
        }
        r.served = true;
      }
    }
    if (edits.length) {
      let offset = 0;
      const parts = [];
      for (const { startOffset, endOffset, tag } of edits.sort((a, b) => a.startOffset - b.startOffset)) {
        parts.push(html.slice(offset, startOffset), tag, html.slice(startOffset, endOffset), '</picture>');
        offset = endOffset;
      }
      writeFileSync(page, parts.join('') + html.slice(offset));
      pages[file] = edits.length;
      rewritten += edits.length;
    }
  }
  // Save only the ordinary build's evidence. Isolated audit builds have their own outDir.
  const report = { version: 1, scanned, rewritten, pages, trials: [...trials.values()].map(({ candidate, ...r }) => r) };
  if (resolve(dist) === resolve(site, 'dist')) {
    const dest = join(site, 'docs', 'image-optimization.json');
    atomicWrite(dest, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

export function imageOptimization({ enabled = true, exclude = [] } = {}) {
  let site;
  let origin;
  return {
    name: 'convert-site-images',
    hooks: {
      'astro:config:done': ({ config }) => { site = fileURLToPath(config.root); origin = config.site; },
      'astro:build:done': async ({ dir, logger }) => {
        const stateFile = join(site, '.conversion/state.json');
        const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
        if (!enabled || state.intake?.performance === false || process.env.CONVERSION_AUDIT_BASELINE === '1') return;
        if (state.phase && !activePhases.has(state.phase) && !state.phases?.performance?.startedAt) return;
        const report = await optimizeImages({ site, dist: fileURLToPath(dir), origin, exclude });
        logger.info(`WebP sources added for ${report.rewritten} of ${report.scanned} img elements.`);
      },
    },
  };
}
