#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { assertNodeVersion } from './lib/node-version.mjs';
import { BLOCKED_HOSTS, parseBlockHosts } from './lib/blocked-hosts.mjs';
import { distFile, handler } from './review-serve.mjs';

const HELP = `Usage: npm run audit:lighthouse -- [options] [-- <release verification flags>]

Builds and verifies an isolated release dist, serves it on loopback, then audits it.
Install with npm install --save-dev --save-exact lighthouse@13.6.0. Set CHROME_PATH if
Chrome is not detected. Any flags after -- go to npm run verify:release.

  --routes <paths>        comma-separated paths (default: home and template representatives)
  --all                   every captured HTML page, post and archive (HTTP 200)
  --device <mode>         mobile, desktop or both (default: both)
  --runs <count>          repetitions per page and device (default: 1)
  --threshold <score>     minimum in each of the four categories, 0–100 (default: 90)
  --out <dir>             JSON, HTML and summary (default: review/lighthouse)
  --before-optimizations  build the parity version for the starting release measurement
  --preview               audit existing dist with its current indexing directives
  --block-hosts <hosts>   comma-separated extra hosts to block alongside analytics and live hosts
  --help                  show this help

Exit codes: 0 all scores meet the target, 1 score below target, 2 incomplete audit or usage error.`;

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const PAGE_KINDS = new Set(['page', 'post', 'archive']);
const exec = promisify(execFile);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const optionalJson = (file, fallback) => existsSync(file) ? readJson(file) : fallback;
const unique = (values) => [...new Set(values)];

function localRoute(path) {
  if (!/^\/(?!\/)/.test(path) || /[\\#\s\u0000-\u001f\u007f]/u.test(path)) throw new Error(`expected a local route, got ${JSON.stringify(path)}`);
  return path;
}

export function auditOptions(argv) {
  const separator = argv.indexOf('--');
  const verify = separator < 0 ? [] : argv.slice(separator + 1);
  const { values } = parseArgs({
    args: separator < 0 ? argv : argv.slice(0, separator),
    options: {
      routes: { type: 'string' },
      all: { type: 'boolean' },
      device: { type: 'string', default: 'both' },
      runs: { type: 'string', default: '1' },
      threshold: { type: 'string', default: '90' },
      out: { type: 'string', default: 'review/lighthouse' },
      preview: { type: 'boolean' },
      'before-optimizations': { type: 'boolean' },
      'block-hosts': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return values;
  if (values.preview && values['before-optimizations']) throw new Error('baseline measurement requires a release build');
  if (values.all && values.routes !== undefined) throw new Error('choose --all or --routes');
  if (!['mobile', 'desktop', 'both'].includes(values.device)) throw new Error('--device must be mobile, desktop or both');
  const runs = Number(values.runs);
  const threshold = Number(values.threshold);
  if (!/^\d+$/.test(values.runs) || runs < 1 || runs > 10) throw new Error('--runs must be an integer between 1 and 10');
  if (!values.threshold.trim() || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error('--threshold must be a number between 0 and 100');
  }
  if (verify.some((flag) => /^(?:--dist(?:=|$)|--help$|-h$)/.test(flag)) || (values.preview && verify.length)) {
    throw new Error('invalid release verification flags: the runner fixes --dist, reserves --help, and skips release verification with --preview');
  }
  return {
    ...values, runs, threshold, verify,
    routes: values.routes === undefined ? null : unique(values.routes.split(',').map((path) => localRoute(path.trim()))),
    devices: values.device === 'both' ? ['mobile', 'desktop'] : [values.device],
    blockHosts: values['block-hosts'] === undefined ? [] : parseBlockHosts(values['block-hosts']),
  };
}

function auditRoutes(site, { routes, all }) {
  if (routes) return routes;
  if (all) return unique(readJson(join(site, 'baseline/routes.json'))
    .filter(({ status, kind }) => status === 200 && PAGE_KINDS.has(kind)).map(({ path }) => localRoute(path)));
  const templates = optionalJson(join(site, 'capture/templates.json'), []);
  return unique(['/', ...templates.map(({ representative }) => localRoute(representative))]);
}

function auditMedia(site) {
  const plan = optionalJson(join(site, 'docs/media-plan.json'), {});
  const files = new Map();
  if (plan.mode !== 'store' || !plan.prefix) return files;
  const manifest = optionalJson(join(site, 'media-manifest.json'), []);
  const cache = join(site, '.conversion/media-cache');
  for (const { path, bytes } of manifest) {
    if (!path.startsWith(plan.prefix)) continue;
    const file = distFile(cache, path);
    if (file && statSync(file).size === bytes) files.set(file, path);
  }
  return files;
}

function auditPatterns(meta, extra, base) {
  const loopback = new URL(base);
  const hosts = new Set([...BLOCKED_HOSTS, ...extra]);
  const patterns = new Set();
  const block = (name) => {
    patterns.add(`*://${name}/*`);
    patterns.add(`*://${name}:*/*`);
  };
  for (const value of [meta.origin, meta.canonicalOrigin].filter(Boolean)) {
    const live = new URL(value);
    if (live.hostname === loopback.hostname) {
      if (live.origin !== loopback.origin) patterns.add(`${live.origin}/*`);
    } else {
      const apex = live.hostname.replace(/^www\./, '');
      block(apex);
      block(`www.${apex}`);
    }
  }
  for (const host of hosts) {
    if (loopback.hostname === host || loopback.hostname.endsWith(`.${host}`)) {
      throw new Error(`blocked host ${host} matches the audit server`);
    }
    block(host);
    block(`*.${host}`);
  }
  return [...patterns];
}

async function runChild(command, args, options) {
  try {
    return await exec(command, args, { ...options, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const details = [error.stderr?.trim(), error.stdout?.trim()].filter(Boolean).join('\n');
    throw new Error(details || error.message, { cause: error });
  }
}

async function openServer(options) {
  const server = createServer(handler(options));
  await new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ready);
  });
  return server;
}

export function scoreLighthouse(report, threshold) {
  if (report.runtimeError) throw new Error(report.runtimeError.message || 'Lighthouse runtime error');
  const scores = {};
  for (const category of CATEGORIES) {
    const score = report.categories?.[category]?.score;
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`Lighthouse did not report a valid ${category} score`);
    scores[category] = Math.round(score * 100);
  }
  const metrics = {};
  for (const [name, id] of Object.entries({ lcpMs: 'largest-contentful-paint', cls: 'cumulative-layout-shift', tbtMs: 'total-blocking-time' })) {
    metrics[name] = report.audits?.[id]?.numericValue ?? null;
  }
  const imageBytes = report.audits?.['resource-summary']?.details?.items?.find(({ resourceType }) => resourceType === 'image')?.transferSize;
  return { scores, ...metrics, imageBytes: imageBytes ?? null, passed: Object.values(scores).every((score) => score >= threshold) };
}

async function auditPage({ url, dir, route, device, run, cli, child, patterns, threshold }) {
  const id = createHash('sha256').update(route).digest('hex').slice(0, 16);
  const name = `${id}-${device}-${run}.report`;
  const json = `${name}.json`;
  const html = `${name}.html`;
  for (const file of [json, html]) rmSync(join(dir, file), { force: true });
  const args = [cli, url, '--quiet', '--chrome-flags=--headless=new', '--output=json', '--output=html',
    `--output-path=${join(dir, name.slice(0, -'.report'.length))}`, '--only-categories', ...CATEGORIES,
    '--blocked-url-patterns', ...patterns];
  if (device === 'desktop') args.push('--preset=desktop');
  await runChild(process.execPath, args, { ...child, timeout: 180_000, killSignal: 'SIGINT' });
  if (!existsSync(join(dir, html))) throw new Error(`Lighthouse did not write ${html}`);
  const report = readJson(join(dir, json));
  const measurement = scoreLighthouse(report, threshold);
  const expected = new URL(url);
  // A page redirecting to a login page or to another origin did not get audited.
  const final = new URL(report.finalDisplayedUrl ?? report.finalUrl);
  if (final.origin !== expected.origin || final.pathname !== expected.pathname) throw new Error(`Lighthouse redirected to ${final.href}`);
  const imageRequests = (report.audits?.['network-requests']?.details?.items ?? [])
    .filter(({ url }) => typeof url === 'string' && url.startsWith(expected.origin + '/_astro/converted-images/'))
    .map(({ url, transferSize }) => ({ path: new URL(url).pathname, transferBytes: transferSize }));
  return { route, device, run, json, html, imageRequests, version: report.lighthouseVersion, warnings: report.runWarnings ?? [], ...measurement };
}

function lighthouseCli(site) {
  const require = createRequire(join(site, 'package.json'));
  try {
    return require.resolve('lighthouse/cli/index.js');
  } catch {
    throw new Error('Lighthouse is unavailable. Run npm install --save-dev --save-exact lighthouse@13.6.0');
  }
}

export async function runAudit(options, { site = process.cwd(), signal } = {}) {
  const out = resolve(site, options.out);
  mkdirSync(out, { recursive: true });
  const summary = {
    beforeOptimizations: Boolean(options['before-optimizations']),
    status: 'running', indexing: options.preview ? 'existing preview' : 'isolated release', threshold: options.threshold,
    devices: options.devices, runs: options.runs, routes: [], results: [], errors: [], notCovered: [],
  };
  const save = () => writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const gaps = new Set();
  const cached = new Set();
  let root;
  let server;
  save();
  try {
    const cli = lighthouseCli(site);
    summary.routes = auditRoutes(site, options);
    if (!summary.routes.length) throw new Error('no captured pages selected');
    const env = { ...process.env };
    const npmArgs = env.npm_execpath ? [env.npm_execpath] : [];
    const npm = npmArgs.length ? process.execPath : 'npm';
    if (!env.CHROME_PATH) {
      const { chromium } = await import('playwright');
      const executable = chromium.executablePath();
      if (existsSync(executable)) env.CHROME_PATH = executable;
    }
    let dist = join(site, 'dist');
    if (!options.preview) {
      root = mkdtempSync(join(tmpdir(), 'astro-lighthouse-'));
      dist = join(root, 'dist');
      const release = { cwd: site, env: { ...env, PUBLIC_INDEXABLE: 'true', PROPOSALS: '', CONVERSION_AUDIT_BASELINE: options['before-optimizations'] ? '1' : '' }, signal, timeout: 300_000 };
      await runChild(npm, [...npmArgs, 'run', 'build', '--', '--outDir', dist], release)
        .catch((error) => { throw new Error(`release build failed\n${error.message}`); });
      await runChild(npm, [...npmArgs, 'run', 'verify:release', '--', '--dist', dist, ...options.verify], release)
        .catch((error) => { throw new Error(`release verification failed\n${error.message}`); });
    }
    if (!existsSync(join(dist, 'index.html'))) throw new Error('no built homepage in the audit output directory');
    const cache = join(site, '.conversion/media-cache');
    const media = auditMedia(site);
    const cleanUrls = !existsSync(join(site, 'vercel.json'));
    server = await openServer({ dir: site, dist, audit: {
      cleanUrls,
      cachedMedia(path) {
        if (!media.size) return null;
        const file = distFile(cache, path);
        if (!media.has(file)) return null;
        cached.add(media.get(file));
        return file;
      },
      unavailable(path, reason) { gaps.add(`${path} (${reason})`); },
    } });
    const base = `http://127.0.0.1:${server.address().port}`;
    const meta = optionalJson(join(site, 'baseline/meta.json'), {});
    const patterns = auditPatterns(meta, options.blockHosts, base);
    summary.blockedUrlPatterns = patterns;
    const child = { cwd: site, env, signal };
    for (const route of summary.routes) {
      const url = new URL(route, base).href;
      const response = await fetch(url, { redirect: 'manual', signal });
      await response.body?.cancel();
      if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('text/html')) {
        throw new Error(`${route} did not serve an HTML page directly (HTTP ${response.status})`);
      }
      for (const device of options.devices) {
        for (let run = 1; run <= options.runs; run++) {
          const result = await auditPage({ url, dir: out, route, device, run, cli, child, patterns, threshold: options.threshold });
          summary.results.push(result);
          console.log(`${route} ${device} (run ${run}): ${CATEGORIES.map((key) => `${key} ${result.scores[key]}`).join(', ')}`);
          save();
        }
      }
    }
    summary.status = summary.results.every(({ passed }) => passed) ? 'passed' : 'below target';
  } catch (error) {
    summary.status = 'incomplete';
    summary.errors.push(error.message);
    console.error(error.message);
  } finally {
    if (server) {
      await new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      });
    }
    if (root) rmSync(root, { recursive: true, force: true });
    summary.cachedMedia = [...cached].sort();
    summary.notCovered = [...gaps].sort();
    for (const gap of summary.notCovered) console.log(`Not covered: ${gap}`);
    save();
    console.log(`Lighthouse ${summary.status}. ${join(out, 'summary.json')}`);
  }
  return summary.status === 'passed' ? 0 : summary.status === 'below target' ? 1 : 2;
}

async function main() {
  assertNodeVersion();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const options = auditOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else process.exitCode = await runAudit(options, { signal: controller.signal });
  } catch (error) {
    console.error(`audit:lighthouse: ${error.message}`);
    process.exitCode = 2;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
