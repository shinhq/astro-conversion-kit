import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PERFORMANCE_CHECKS, performanceProof } from '../../skills/convert-site/scripts/lib/performance-proof.mjs';
import { auditOptions } from '../../skills/convert-site/scripts/audit-lighthouse.mjs';

const script = fileURLToPath(new URL('../../skills/convert-site/scripts/audit-lighthouse.mjs', import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Stand-in for the browser process. It loads real pages from the runner's local server and
// returns Lighthouse's CLI output shape. The fixture never makes requests to public services.
const CLI = `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const [url, ...args] = process.argv.slice(2);
const page = await fetch(url);
assert.equal(page.status, 200);
assert.match(await page.text(), process.env.FIXTURE_PREVIEW ? /noindex/ : /indexable/);
assert.ok(args.includes('*://mixpanel.com/*'));
if (process.env.FIXTURE_MEDIA) {
  assert.equal(await (await fetch(new URL('/uploads/keep.jpg', url))).text(), 'photo');
  assert.equal((await fetch(new URL('/other', url), { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(new URL('/external-redirect', url), { redirect: 'manual' })).status, 404);
}
const out = args.find((arg) => arg.startsWith('--output-path=')).slice(14);
const score = args.includes('--preset=desktop') ? .94 : .88;
const categories = Object.fromEntries(['performance', 'accessibility', 'best-practices', 'seo'].map((id) => [id, { score }]));
writeFileSync(out + '.report.json', JSON.stringify({ finalDisplayedUrl: page.url, lighthouseVersion: 'fixture', categories }));
writeFileSync(out + '.report.html', '<p>Fixture report</p>');`;

function fixture(t, { lighthouse = true, upstream } = {}) {
  const site = mkdtempSync(join(tmpdir(), 'audit-fixture-'));
  t.after(() => rmSync(site, { recursive: true, force: true }));
  const write = (file, content) => {
    const path = join(site, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  };
  write('package.json', { type: 'module', scripts: { build: 'node build.mjs', 'verify:release': 'node verify.mjs' } });
  write('dist/index.html', '<meta name="robots" content="noindex">');
  write('dist/robots.txt', 'User-agent: *\nDisallow: /\n');
  write('capture/templates.json', [{ representative: '/' }, { representative: '/about/' }]);
  write('baseline/routes.json', [{ path: '/', kind: 'page', status: 200 }, { path: '/about/', kind: 'page', status: 200 },
    { path: '/feed/', kind: 'feed', status: 200 }, { path: '/gone/', kind: 'page', status: 404 }]);
  write('baseline/meta.json', { origin: upstream ?? 'https://www.example.com' });
  write('build.mjs', `import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
assert.equal(process.env.PUBLIC_INDEXABLE, 'true');
assert.equal(process.argv[2], '--outDir');
const dist = process.argv[3];
mkdirSync(join(dist, 'about'), { recursive: true });
writeFileSync(join(dist, 'index.html'), '<title>indexable</title>');
writeFileSync(join(dist, 'about/index.html'), '<title>indexable</title>');`);
  write('verify.mjs', `import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
assert.equal(process.env.PUBLIC_INDEXABLE, 'true');
assert.ok(existsSync(join(process.argv[3], 'index.html')));
assert.deepEqual(process.argv.slice(4), ['--honeypot', '_gotcha']);
if (process.env.FIXTURE_FAIL_VERIFY) process.exit(1);`);
  if (upstream) {
    write('vercel.json', { rewrites: [{ source: '/other', destination: `${upstream}/remote` }],
      redirects: [{ source: '/external-redirect', destination: `${upstream}/remote`, statusCode: 302 }] });
    write('docs/media-plan.json', { mode: 'store', prefix: '/uploads/' });
    write('media-manifest.json', [{ path: '/uploads/keep.jpg', bytes: 5 }]);
    write('.conversion/media-cache/uploads/keep.jpg', 'photo');
  }
  if (lighthouse) write('node_modules/lighthouse/cli/index.js', CLI);
  mkdirSync(join(site, 'tmp'));
  return { site, summary: () => readJson(join(site, 'review/lighthouse/summary.json')) };
}

function run(site, args, extra = {}) {
  const env = { ...process.env, ...extra, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    CHROME_PATH: '/fixture/chrome', PUBLIC_INDEXABLE: '', TMPDIR: join(site, 'tmp') };
  return new Promise((done) => {
    execFile(process.execPath, [script, ...args], { cwd: site, env, timeout: 30_000 }, (error, stdout, stderr) => {
      done({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('release audit measures the representative routes on both devices and leaves preview output intact', async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer((req, res) => { upstreamRequests++; res.end('unexpected'); });
  await new Promise((ready) => upstream.listen(0, '127.0.0.1', ready));
  t.after(() => new Promise((done) => upstream.close(done)));
  const { site, summary } = fixture(t, { upstream: `http://127.0.0.1:${upstream.address().port}` });
  const result = await run(site, ['--runs', '2', '--block-hosts', 'tracker.example.com', '--', '--honeypot', '_gotcha'], { FIXTURE_MEDIA: '1' });
  assert.equal(result.code, 1, result.stderr);
  const data = summary();
  assert.equal(data.status, 'below target');
  assert.deepEqual(data.routes, ['/', '/about/']);
  assert.equal(data.results.length, 8);
  assert.equal(data.results.filter((item) => item.passed).length, 4);
  assert.deepEqual(data.cachedMedia, ['/uploads/keep.jpg']);
  assert.deepEqual(data.notCovered, ['/external-redirect (external redirect)', '/other (external rewrite or missing cached media)']);
  assert.ok(data.blockedUrlPatterns.includes(`http://127.0.0.1:${upstream.address().port}/*`));
  assert.ok(data.blockedUrlPatterns.includes('*://tracker.example.com/*'));
  for (const item of data.results) {
    assert.ok(existsSync(join(site, 'review/lighthouse', item.json)));
    assert.ok(existsSync(join(site, 'review/lighthouse', item.html)));
  }
  assert.equal(upstreamRequests, 0);
  assert.match(readFileSync(join(site, 'dist/index.html'), 'utf8'), /noindex/);
  assert.match(readFileSync(join(site, 'dist/robots.txt'), 'utf8'), /Disallow: \//);
  assert.ok(!readdirSync(join(site, 'tmp')).some((name) => name.startsWith('astro-lighthouse-')));
  const all = await run(site, ['--all', '--device', 'desktop', '--', '--honeypot', '_gotcha']);
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(summary().routes, ['/', '/about/']);
});

test('explicit preview routes and incomplete release audits have distinct outcomes', async (t) => {
  const { site, summary } = fixture(t);
  const preview = await run(site, ['--preview', '--routes', '/', '--device', 'mobile', '--threshold', '80'], { FIXTURE_PREVIEW: '1' });
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(summary().indexing, 'existing preview');
  const badGate = await run(site, ['--', '--honeypot', '_gotcha'], { FIXTURE_FAIL_VERIFY: '1' });
  assert.equal(badGate.code, 2, badGate.stderr);
  assert.match(summary().errors[0], /release verification failed/);
  assert.deepEqual(summary().results, []);
  assert.ok(!readdirSync(join(site, 'tmp')).some((name) => name.startsWith('astro-lighthouse-')));
  const missingTool = fixture(t, { lighthouse: false });
  const missing = await run(missingTool.site, ['--routes', '/']);
  assert.equal(missing.code, 2);
  assert.match(missingTool.summary().errors[0], /Lighthouse is unavailable/);
  assert.throws(() => auditOptions(['--routes', '//example.com/']), /expected a local route/);
  assert.throws(() => auditOptions(['--all', '--routes', '/']), /choose --all or --routes/);
  assert.throws(() => auditOptions(['--', '--dist', 'dist']), /verification flags/);
});

test('default performance closeout uses all seven decisions and comparable release samples', async (t) => {
  const { site } = fixture(t);
  const state = { phases: { performance: { result: { status: 'complete', report: 'docs/performance.md' } } } };
  const first = await run(site, ['--before-optimizations', '--out', 'review/lighthouse/before', '--', '--honeypot', '_gotcha']);
  const second = await run(site, ['--out', 'review/lighthouse/after', '--', '--honeypot', '_gotcha']);
  assert.equal(first.code, 1, first.stderr);
  assert.equal(second.code, 1, second.stderr);
  // All fixture pages contain only the title. There are no optimization candidates.
  const report = PERFORMANCE_CHECKS.map((name) => `### ${name}\n\nNot applicable — the fixture serves title-only HTML.\n`).join('\n') + '\n## Not covered\n\nHosted caching and real-user timings.\n';
  mkdirSync(join(site, 'docs'));
  writeFileSync(join(site, 'docs/image-optimization.json'), JSON.stringify({ version: 1, scanned: 0, rewritten: 0, pages: {}, trials: [] }));
  const doc = join(site, 'docs/performance.md');
  const check = () => performanceProof(site, state);
  writeFileSync(doc, report);
  assert.match(check(), /checklist complete/);
  writeFileSync(doc, report.replace('Not applicable —', 'Blocked —'));
  assert.throws(check, /unfinished optimization checks: WebP/);
  writeFileSync(doc, report);

  const after = join(site, 'review/lighthouse/after/summary.json');
  const summary = readJson(after);
  for (const [change, message] of [
    [{ results: summary.results.slice(1) }, /lacks \/ mobile/],
    [{ threshold: 80 }, /settings differ/],
    [{ routes: ['/'] }, /omits template representatives/],
    [{ indexing: 'existing preview' }, /release build/],
  ]) {
    writeFileSync(after, JSON.stringify({ ...summary, ...change }));
    assert.throws(check, message);
  }
  const incomplete = await run(site, ['--out', 'review/lighthouse/after', '--', '--honeypot', '_gotcha'], { FIXTURE_FAIL_VERIFY: '1' });
  assert.equal(incomplete.code, 2, incomplete.stderr);
  assert.throws(check, /quote the audit errors/);
  writeFileSync(doc, report + '\n### Release audit\n\n' + readJson(after).errors.join('\n'));
  assert.match(check(), /Not covered/);
});

test('npm run optimize measures before and after, rebuilds normally and reuses the starting measurement', async (t) => {
  const { site } = fixture(t);
  const scripts = join(site, 'scripts');
  mkdirSync(scripts);
  copyFileSync(new URL('../../skills/convert-site/templates/site/scripts/optimize.mjs', import.meta.url), join(scripts, 'optimize.mjs'));
  symlinkSync(script, join(scripts, 'audit-lighthouse.mjs'));
  symlinkSync(join(dirname(script), 'state.mjs'), join(scripts, 'state.mjs'));
  const pkg = readJson(join(site, 'package.json'));
  pkg.scripts.optimize = 'node scripts/optimize.mjs';
  pkg.scripts.verify = 'node --version';
  pkg.scripts['review:check'] = 'node --version';
  writeFileSync(join(site, 'package.json'), JSON.stringify(pkg));
  const build = join(site, 'build.mjs');
  writeFileSync(build, `import { appendFileSync } from 'node:fs';
    appendFileSync('builds.txt', process.env.CONVERSION_AUDIT_BASELINE === '1' ? 'before\\n' : process.argv[2] ? 'after\\n' : 'normal\\n');
    if (!process.argv[2]) process.exit(0);
    ${readFileSync(build, 'utf8')}`);
  // This fixture has no form. Its release gate still checks the isolated release flags.
  writeFileSync(join(site, 'verify.mjs'), readFileSync(join(site, 'verify.mjs'), 'utf8').replace("['--honeypot', '_gotcha']", '[]'));
  function optimize() {
    return new Promise((done) => {
      execFile('npm', ['run', 'optimize'], { cwd: site, env: { ...process.env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`, CHROME_PATH: '/fixture/chrome' } },
      (err, stdout, stderr) => done({ code: err?.code ?? 0, stdout, stderr }));
    });
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await optimize();
    assert.equal(result.code, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /Lighthouse below target/);
  }
  assert.equal(readJson(join(site, '.conversion/state.json')).phase, 'performance');
  assert.equal(readFileSync(join(site, 'builds.txt'), 'utf8'), 'before\nnormal\nafter\nnormal\nafter\n');
  assert.equal(readJson(join(site, 'review/lighthouse/before/summary.json')).beforeOptimizations, true);
  assert.equal(readJson(join(site, 'review/lighthouse/after/summary.json')).beforeOptimizations, false);
});
