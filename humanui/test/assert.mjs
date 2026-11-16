// Tiny assertion harness. No dependencies, and it prints a summary the CI-shaped caller can read.
let passed = 0;
let failed = 0;
const failures = [];

export function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`);
  }
  return Boolean(condition);
}

export function section(title) {
  console.log(`\n${title}`);
}

export function summary() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('failed:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  return failed === 0;
}

export function eq(label, actual, expected) {
  return check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}`);
}