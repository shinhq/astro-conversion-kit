import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
