// Test runner. Each file is a separate process so a browser crash in one cannot take the others
// with it, and so an unhandled rejection in one file does not mask the rest.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  { name: 'sandbox isolation', file: 'sandbox-isolation.mjs', browser: false },
  { name: 'url policy', file: 'url-policy.mjs', browser: false },
  { name: 'risk policy', file: 'risk-policy.mjs', browser: false },
  { name: 'network policy', file: 'network-policy.mjs', browser: false },
  { name: 'model client', file: 'model.mjs', browser: false },
  { name: 'network live', file: 'network-live.mjs', browser: true },
  { name: 'tabs', file: 'tabs.mjs', browser: true },
  { name: 'snapshot', file: 'snapshot.mjs', browser: true },
  { name: 'executor', file: 'executor.mjs', browser: true },
  { name: 'agent loop', file: 'loop.mjs', browser: true },
];

const only = process.argv[2];
const selected = only ? SUITES.filter((s) => s.file.includes(only) || s.name.includes(only)) : SUITES;

let failed = 0;
const failedNames = [];
const started = Date.now();

for (const suite of selected) {
  console.log(`\n${'='.repeat(64)}\n  ${suite.name}\n${'='.repeat(64)}`);
  const result = spawnSync(process.execPath, [join(HERE, suite.file)], {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: suite.browser ? 300_000 : 60_000,
  });
  if (result.status !== 0) {
    failed++;
    failedNames.push(suite.name);
    // A suite that dies silently (killed, OOM) leaves status null or a signal, which is worth naming
    // rather than reporting as a bare non-zero exit.
    const how = result.signal ? `killed by ${result.signal}` : `exit ${result.status}`;
    console.log(`  SUITE FAILED (${how})`);
    if (result.error) console.log(`  runner error: ${result.error.message}`);
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${'='.repeat(64)}`);
console.log(failed === 0
  ? `all ${selected.length} suites passed in ${seconds}s`
  : `${failed} of ${selected.length} suites FAILED in ${seconds}s: ${failedNames.join(', ')}`);
console.log('='.repeat(64));

process.exit(failed === 0 ? 0 : 1);