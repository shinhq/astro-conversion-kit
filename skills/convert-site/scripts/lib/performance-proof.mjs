// The conversion report owns the checklist. Lighthouse summaries own the measured coverage.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const PERFORMANCE_CHECKS = [
  'WebP encoding and image localization', 'Responsive image delivery', 'Hero and below-fold loading',
  'CSS and fonts', 'Initial layout and widgets', 'First-party JavaScript', 'Analytics and tags',
];

function read(dir, file) {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`missing ${file}`);
    throw err;
  }
}

function section(report, heading) {
  const lines = report.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) return '';
  const level = heading.indexOf(' ');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    const next = /^(#{1,6})\s/.exec(line);
    if (next && next[1].length <= level) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

function checkAudit(dir, round, representatives, notCovered) {
  const file = `review/lighthouse/${round}/summary.json`;
  const audit = JSON.parse(read(dir, file));
  if (audit.beforeOptimizations !== (round === 'before')) throw new Error(`wrong optimization mode in ${file}`);
  if (audit.indexing !== 'isolated release') throw new Error(`${file} must measure the release build`);
  for (const gap of audit.notCovered ?? []) {
    if (!notCovered.includes(gap)) throw new Error(`quote the coverage gap from ${file} under ## Not covered: ${gap}`);
  }
  if (audit.status === 'incomplete') {
    if (!audit.errors?.length || !audit.errors.every((error) => error && notCovered.includes(error))) {
      throw new Error(`quote the audit errors from ${file} under ## Not covered`);
    }
    return null;
  }
  if (!['passed', 'below target'].includes(audit.status)) throw new Error(`unfinished audit in ${file}`);
  const routes = [...new Set(audit.routes)].sort();
  if (!representatives.every((route) => routes.includes(route))) throw new Error(`${file} omits template representatives`);
  if (!Number.isInteger(audit.runs) || audit.runs < 1 || audit.runs > 10) throw new Error(`invalid run count in ${file}`);
  const samples = new Set(audit.results.map(({ route, device, run }) => JSON.stringify([route, device, run])));
  for (const route of routes) {
    for (const device of ['mobile', 'desktop']) {
      for (let run = 1; run <= audit.runs; run++) {
        if (!samples.has(JSON.stringify([route, device, run]))) throw new Error(`${file} lacks ${route} ${device} run ${run}`);
      }
    }
  }
  return { routes, runs: audit.runs, threshold: audit.threshold, blocked: [...audit.blockedUrlPatterns].sort() };
}

export function checkBuiltImages(dir) {
  const receipt = JSON.parse(read(dir, 'docs/image-optimization.json'));
  if (receipt.version !== 1 || !Number.isSafeInteger(receipt.scanned) || !Number.isSafeInteger(receipt.rewritten)
    || receipt.rewritten < 0 || receipt.rewritten > receipt.scanned || !Array.isArray(receipt.trials)) {
    throw new Error('invalid image optimization report; rebuild the site');
  }
  const served = receipt.trials.filter((trial) => trial.served);
  if (Boolean(served.length) !== Boolean(receipt.rewritten)) throw new Error('inconsistent image optimization report');
  const urls = new Set(served.map((trial) => trial.url));
  const referenced = new Set();
  let total = 0;
  for (const [file, count] of Object.entries(receipt.pages)) {
    if (isAbsolute(file) || file.includes('\\') || file.split('/').includes('..') || !file.endsWith('.html')) {
      throw new Error('invalid page path in image optimization report');
    }
    const html = read(dir, join('dist', file));
    const sources = [...html.matchAll(/<picture><source type="image\/webp" srcset="(\/_astro\/converted-images\/[^"]+)"/g)];
    if (sources.length !== count) throw new Error(`optimized image count differs from the built page: ${file}`);
    for (const [, srcset] of sources) {
      for (const entry of srcset.split(', ')) {
        const url = entry.split(' ')[0];
        if (!urls.has(url)) throw new Error(`unmeasured image on ${file}: ${url}`);
        referenced.add(url);
      }
    }
    total += count;
  }
  if (total !== receipt.rewritten || referenced.size !== urls.size) throw new Error('optimized image references differ from the build report');
  for (const trial of served) {
    if (!/^[a-f0-9]{64}$/.test(trial.hash) || trial.url !== `/_astro/converted-images/${trial.hash}.webp`) {
      throw new Error('invalid generated image path in docs/image-optimization.json');
    }
    const bytes = readFileSync(join(dir, 'dist', trial.url));
    if (bytes.length !== trial.candidateBytes || bytes.length >= trial.originalBytes
      || createHash('sha256').update(bytes).digest('hex') !== trial.hash) {
      throw new Error(`generated image differs from its measured result: ${trial.url}`);
    }
  }
}

export function performanceProof(dir, state) {
  const result = state.phases?.performance?.result;
  if (state.intake?.performance === false) {
    if (result?.status !== 'skipped' || result.reason !== 'parity only') throw new Error('record the parity-only skip');
    return 'Performance skipped at intake (parity only).';
  }
  const report = read(dir, 'docs/performance.md').replaceAll('\r\n', '\n');
  const missing = PERFORMANCE_CHECKS.filter((name) => {
    const entry = section(report, `### ${name}`);
    return !/^(Applied|Verified unchanged|Not applicable) — \S/.test(entry);
  });
  if (missing.length) throw new Error(`unfinished optimization checks: ${missing.join(', ')} (see references/performance.md)`);
  const gaps = section(report, '## Not covered');
  if (!gaps) throw new Error('document coverage under ## Not covered in docs/performance.md');
  const templates = JSON.parse(read(dir, 'capture/templates.json'));
  const representatives = ['/', ...templates.map(({ representative }) => representative)];
  checkBuiltImages(dir);
  const before = checkAudit(dir, 'before', representatives, gaps);
  const after = checkAudit(dir, 'after', representatives, gaps);
  if (before && after && !isDeepStrictEqual(before, after)) throw new Error('before and after audit settings differ');
  if (result?.status !== 'complete' || result.report !== 'docs/performance.md') throw new Error('record the completed performance result in state');
  return before && after ? 'Performance checklist complete.' : 'Performance checklist complete. Release Lighthouse comparison: Not covered (see docs/performance.md).';
}
