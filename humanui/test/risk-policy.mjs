// Risk classification for the approval interlock.
//
// The classification is the policy. If it is too loose the interlock is theatre; too tight and the
// operator is asked about harmless clicks until they click through everything. These cases pin the
// boundaries deliberately, including the asymmetry between clicks and typing.

import { check, section, summary } from './assert.mjs';
import { classifyRisk, RISK } from '../src/agent/approvals.mjs';

const risk = (action, opts) => classifyRisk(action, opts).risk;
const rule = (action, opts) => classifyRisk(action, opts).rule;

section('destructive actions are high risk');

for (const name of [
  'Delete everything', 'Remove row', 'wipe', 'Erase all data', 'purge', 'Clear all',
  'Revoke access', 'Terminate account', 'drop database',
]) {
  check(`"${name}" is high risk`,
    risk({ kind: 'click', name }) === RISK.HIGH, rule({ kind: 'click', name }));
}

section('spending and commitment are high risk');

for (const name of ['Buy now', 'Purchase', 'Pay $9.99', 'Checkout', 'Subscribe', 'Place order', 'Upgrade to Pro']) {
  check(`"${name}" is high risk`,
    risk({ kind: 'click', name }) === RISK.HIGH, rule({ kind: 'click', name }));
}

section('consent is low risk, not high');

for (const name of ['Accept cookies', 'Agree to terms', 'Authorize', 'Confirm']) {
  check(`"${name}" is low risk`,
    risk({ kind: 'click', name }) === RISK.LOW, rule({ kind: 'click', name }));
}

section('ordinary controls are not gated');

for (const name of ['Apply filters', 'Search', 'Reset', 'Play / Pause', 'Add to queue', 'Next page']) {
  check(`"${name}" is not gated`, risk({ kind: 'click', name }) === RISK.NONE, rule({ kind: 'click', name }));
}

section('typing is gated by where it goes, not what it says');

// "Typing sensitive information into a form counts as transmission."
const inPassword = risk({ kind: 'type', length: 8 }, { elementHtml: '<input type="password">' });
check('typing into a password field is high risk', inPassword === RISK.HIGH, 'sensitive-field');

const inPlain = risk({ kind: 'type', length: 8 }, { elementHtml: '<input type="text">' });
check('typing into an ordinary field is not gated', inPlain === RISK.NONE);

const longText = risk({ kind: 'type', length: 400 }, { elementHtml: '<textarea>' });
check('a very long value is at least low risk', longText === RISK.LOW, 'long-input');

section('a submit next to sensitive data is a transmission');

const transmit = risk(
  { kind: 'click', name: 'Submit payment' },
  { elementHtml: '<form><input type="password"><button>Submit</button></form>' },
);
check('submitting near a password field is high risk', transmit === RISK.HIGH, rule({ kind: 'click', name: 'Submit payment' }, { elementHtml: '<input type="password">' }));

section('classification falls back when there is no accessible name');

check('coordinate click with no name is not gated',
  risk({ kind: 'click', name: null, node: '<div>', via: 'coordinate' }) === RISK.NONE);
check('a node descriptor is used when no name is present',
  risk({ kind: 'click', node: '<button id=wipe>' }) === RISK.HIGH, 'destructive via id');

section('every high-risk verdict explains itself');

for (const name of ['Delete everything', 'Buy now', 'Accept terms']) {
  const verdict = classifyRisk({ kind: 'click', name });
  check(`"${name}" carries a reason`, typeof verdict.reason === 'string' && verdict.reason.length > 10,
    verdict.reason);
}

process.exitCode = summary() ? 0 : 1;