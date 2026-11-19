import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeBuiltLinks, normalizeContentLinks } from '../../skills/parity-gates/scripts/lib/normalize-content-links.mjs';

const origin = 'https://www.example.com';

test('normalizes only eligible href attributes and preserves queries, fragments and existing HTML bytes', () => {
  const input = `<!DOCTYPE html><HTML><HEAD>
<link rel="canonical" href="${origin}/contact/"><link rel="alternate" href="${origin}/contact/">
<meta property="og:url" content="${origin}/contact/"><script type="application/ld+json">{"url":"${origin}/contact/"}</script>
</HEAD><BODY><a HREF = 'http://example.com/contact/?ref=a%2fb&amp;x=1#book'>Contact</a>
<map><area href=//www.example.com/old#team></map>
<a href="${origin}/?p=2#team">Shortlink</a><a href="${origin}/?p=3">Unknown shortlink</a>
<a href="${origin}/?s=test">Search</a><a href="${origin}/wp-admin/">Login</a>
<a href="${origin}/excluded/path/">Excluded</a><a href="${origin}/missing/">Missing</a>
<a href="${origin}/excepted/">Excepted</a><a href="${origin}/hop-offsite/">Off-site redirect</a>
<a href="${origin}/wp-content/file.pdf">Download</a><a href="${origin}//other.example.com/">Double slash</a>
<a href="https://other.example.com/contact/">External</a><a href="https://example.com:8443/contact/">Other port</a>
<a href="https://user@example.com/contact/">Userinfo</a><a href="/contact/">Root</a><a href="#footer">Fragment</a>
<form action="${origin}/contact/"></form><script>const example = '<a href="${origin}/contact/">';</script></BODY></HTML>`;
  const relative = { hops: [{ to: '/contact/' }], final: { status: 200 } };
  const result = normalizeContentLinks(input, {
    origin, hosts: new Set(['example.com']), excluded: ['/excluded/'], excepted: new Set([`${origin}/excepted/`]),
    stored: new Set(['/wp-content/file.pdf']),
    resolve(path) {
      if (path === '/old' || path === '/?p=2') return relative;
      if (path === '/hop-offsite/') return { ...relative, hops: [{ to: `${origin}/contact/` }] };
      return { hops: [], final: { status: path === '/missing/' ? 404 : 200 } };
    },
  });
  assert.equal(result.changed, 4);
  assert.equal(result.preserved, 8);
  assert.equal(result.html, input
    .replace("HREF = 'http://example.com/contact/?ref=a%2fb&amp;x=1#book'", 'href="/contact/?ref=a%2fb&amp;x=1#book"')
    .replace('href=//www.example.com/old#team', 'href="/old#team"')
    .replace(`href="${origin}/?p=2#team"`, 'href="/?p=2#team"')
    .replace(`href="${origin}/wp-content/file.pdf"`, 'href="/wp-content/file.pdf"'));
});

test('the build step uses the selected output directory, honors the media manifest and reports an off-site base', (t) => {
  const site = mkdtempSync(join(tmpdir(), 'normalize-links-'));
  t.after(() => rmSync(site, { recursive: true, force: true }));
  const write = (file, content) => {
    const full = join(site, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const validMedia = '/wp-content/uploads/file.pdf';
  const missingMedia = '/wp-content/uploads/missing.pdf';
  const home = `<a href="${origin}/contact/">Next</a><a href="${origin}${validMedia}">Download</a><a href="${origin}${missingMedia}">Missing</a>`;
  write('dist/index.html', home);
  write('release/index.html', home);
  write('release/contact/index.html', `<base href="${origin}/"><a href="${origin}/">Home</a>`);
  write('release/404.html', `<a href="${origin}/">Home</a>`);
  write('baseline/meta.json', { origin, platform: 'wordpress' });
  write('baseline/media.json', [{ path: validMedia, bytes: 12 }, { path: missingMedia, bytes: 10 }]);
  write('docs/media-plan.json', { mode: 'store', prefix: '/wp-content/uploads/' });
  write('media-manifest.json', [{ path: validMedia, bytes: 12 }, { path: missingMedia, bytes: 9 }]);
  write('vercel.json', {});
  const messages = [];
  const log = (message) => messages.push(message);
  normalizeBuiltLinks({ site, dist: join(site, 'release'), host: 'vercel', logger: { warn: log, info: log } });
  const read = (file) => readFileSync(join(site, file), 'utf8');
  assert.equal(read('dist/index.html'), home);
  assert.equal(read('release/index.html'), home.replace(`${origin}/contact/`, '/contact/').replace(`${origin}${validMedia}`, validMedia));
  assert.equal(read('release/404.html'), '<a href="/">Home</a>');
  assert.match(messages.join('\n'), /\/contact\/: absolute <base href>.*\nNormalized 3 same-site links on 2\/3 pages/);
});
