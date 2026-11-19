#!/usr/bin/env node
// Internal tool for prelaunch-reconcile. Reads { check, env } from stdin.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checks as outputChecks } from '../skills/pre-launch/scripts/lib/output.mjs';
import { distFiles } from '../skills/parity-gates/scripts/lib/dist.mjs';
import { canonicalPath } from '../skills/parity-gates/scripts/lib/excluded.mjs';
import { navigationResolver, storedMedia } from '../skills/parity-gates/scripts/lib/normalize-content-links.mjs';
import { rewriteServes } from '../skills/convert-site/scripts/prelaunch-reconcile.mjs';

const listedCount = (detail) => Number(/^([0-9]+)\b/.exec(detail)?.[1] ?? 0);

// The upstream check only looks for physical files. Run the same enumerator per source to
// recover its normally capped evidence, then prove every destination against the host rules.
function localReferenceRows(check, env) {
  const failed = (reason) => ({ ok: false, rows: [{ text: check.detail, ok: false, reason }] });
  if (!existsSync(env.dist)) return failed(`missing build output in ${env.dist}`);
  const files = distFiles(env.dist);
  const context = { buildDir: env.dist, buildDirNote: null, fileSet: new Set(files), prodOrigin: 'https://site.invalid' };
  const checkRefs = outputChecks.find(({ id }) => id === check.id);
  const evidence = new Set();
  for (const rel of files) {
    const html = /\.html?$/i.test(rel);
    if (!html && !rel.endsWith('.css')) continue;
    const result = checkRefs.run({
      ...context,
      files: html ? [] : [rel],
      html: html ? new Map([[rel, { raw: readFileSync(join(env.dist, rel), 'utf8') }]]) : new Map(),
    })[0];
    if (!result) continue;
    if (listedCount(result.detail) !== result.evidence.length) return failed(`pre-launch capped the evidence in ${rel}`);
    for (const { value } of result.evidence) evidence.add(value);
  }
  if (evidence.size !== listedCount(check.detail) || check.evidence.some(({ value }) => !evidence.has(value))) {
    return failed('the audited references do not match the current build');
  }
  const site = env.dir;
  const host = existsSync(join(site, 'vercel.json')) ? 'vercel' : 'cloudflare';
  const resolve = navigationResolver({ site, dist: env.dist, host });
  const stored = env.baselineDir && env.mediaPlan?.mode === 'store' ? storedMedia(site, env.baselineDir) : new Set();
  const destinations = new Map();
  const rows = [...evidence].map((text) => {
    const path = /^.+ -> (\/[^?#]*)$/.exec(text)?.[1];
    if (!path) return { text, ok: false, reason: 'unrecognized reference' };
    if (!destinations.has(path)) {
      // The upstream check strips trailing slashes from its evidence. The kit's links gate
      // separately verifies the literal href and query in the markup.
      const serves = [path, `${path}/`].some((url) => {
        const { hops, final } = resolve(url);
        return final.status === 200 && hops.length <= 1;
      });
      destinations.set(path, serves || (stored.has(canonicalPath(path)) && Boolean(rewriteServes(env, path))));
    }
    return { text, ok: destinations.get(path), reason: destinations.get(path) ? null : 'no verified host route or stored file' };
  });
  return { ok: rows.every(({ ok }) => ok), rule: 'host-routes', decision: null, rows };
}

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/replay-internal-refs.mjs < payload.json\nReads { check, env } from stdin and returns reference evidence as JSON.');
} else {
  const { check, env } = JSON.parse(readFileSync(0, 'utf8'));
  console.log(JSON.stringify(localReferenceRows(check, env)));
}
