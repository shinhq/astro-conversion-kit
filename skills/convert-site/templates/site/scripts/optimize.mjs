#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { auditOptions, runAudit } from './audit-lighthouse.mjs';
import { readState } from './state.mjs';

const help = `Usage: npm run optimize -- [Lighthouse sampling options] [-- <verification flags>]

Run after visual parity. Measure the unoptimized release, build and verify optimized output,
then measure the optimized release with the same sampling options. A retry reuses the saved
starting measurement. Exit 1 means scores below target or a failed gate, 2 an incomplete audit.
See npm run audit:lighthouse -- --help for the sampling options.`;

async function main(args) {
  const options = auditOptions(args);
  if (options.help) {
    console.log(help);
    return 0;
  }
  if (options.preview || options['before-optimizations'] || options.out !== 'review/lighthouse') {
    throw new Error('optimize manages the before/after release builds and output directories');
  }
  const site = process.cwd();
  const state = readState(site);
  if (state.intake?.performance === false) {
    console.log('Performance skipped at intake (parity only).');
    return 0;
  }
  // Using npm's current CLI also works when npm is a .cmd shim on Windows.
  const npm = (...args) => execFileSync(process.execPath, [process.env.npm_execpath, 'run', ...args], { stdio: 'inherit' });
  if (!['performance', 'prelaunch', 'suggestions', 'pr'].includes(state.phase)) {
    npm('verify', '--', ...options.verify);
    npm('review:check');
    execFileSync(process.execPath, ['scripts/state.mjs', '--dir', '.', 'phase', 'performance'], { stdio: 'inherit' });
  }
  const before = 'review/lighthouse/before';
  const summaryFile = before + '/summary.json';
  const saved = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : null;
  let baseline;
  if (saved?.beforeOptimizations && ['passed', 'below target'].includes(saved.status)) {
    console.log(`Reusing starting measurement in ${summaryFile}`);
    baseline = 0; // The below-target starting score remains in the report.
  } else {
    baseline = await runAudit({ ...options, out: before, 'before-optimizations': true });
  }
  npm('build');
  npm('verify', '--', ...options.verify);
  const after = await runAudit({ ...options, out: 'review/lighthouse/after' });
  console.log('Review docs/image-optimization.json, validate visual parity and finish the seven checklist outcomes.');
  return baseline === 2 ? 2 : after;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = error.status || 2;
}
