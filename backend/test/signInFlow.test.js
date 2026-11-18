import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSendCode,
  dobHandoffStatus,
  isDobChallenge,
  isEmailRadioName,
  isPasskeyEnrollment,
  nextAfterCodeAccepted,
  planEmailDelivery,
  shouldStartCodePoll,
} from '../src/signInFlow.js';

const passcodeRadios = [
  { name: 'Text', selected: true },
  { name: 'Call', selected: false },
  { name: 'Email', selected: false },
];

test('selects the Email radio before Send code when Text is the default', () => {
  const plan = planEmailDelivery(passcodeRadios);
  assert.equal(plan.ok, true);
  assert.equal(plan.selectEmail, true);
  assert.equal(plan.textWasDefault, true);
  assert.equal(canSendCode({ emailSelected: false }), false);
  assert.equal(canSendCode({ emailSelected: true }), true);
  assert.equal(shouldStartCodePoll({ emailSelected: false, sendClicked: true }), false);
  assert.equal(shouldStartCodePoll({ emailSelected: true, sendClicked: false }), false);
  assert.equal(shouldStartCodePoll({ emailSelected: true, sendClicked: true }), true);
  assert.equal(isEmailRadioName('Email'), true);
  assert.equal(isEmailRadioName('Email j****a@creditandjourney.com'), true);
  assert.equal(/^Email$/i.test('Email j****a@creditandjourney.com'), false);
  assert.equal(isEmailRadioName('Text'), false);
  assert.equal(isEmailRadioName('Call'), false);
  const masked = planEmailDelivery([
    { name: 'Text', selected: true },
    { name: 'Call', selected: false },
    { name: 'Email j****a@creditandjourney.com', selected: false },
  ]);
  assert.equal(masked.ok, true);
  assert.equal(masked.selectEmail, true);
  assert.equal(masked.textWasDefault, true);
  assert.equal(canSendCode({ emailSelected: false }), false);
});

test('declines passkey enrollment instead of creating one', () => {
  const page = { pathname: '/account-login/passwordless-enrollment', text: 'Create a passkey Not now' };
  assert.equal(isPasskeyEnrollment(page), true);
  assert.equal(nextAfterCodeAccepted(page), 'decline-passkey');
  assert.equal(nextAfterCodeAccepted({ pathname: '/extracare/manage', text: 'card ***6145' }), 'verify-identity');
});

test('pauses on the date-of-birth page and does not carry a date into the handoff', () => {
  const challenge = {
    pathname: '/account-login/verify-user',
    text: 'Verify your identity. Date of birth.',
  };
  assert.equal(isDobChallenge(challenge), true);
  assert.equal(isDobChallenge({ pathname: '/account-login/one-time-passcode', text: 'Text Call Email Send code' }), false);
  assert.equal(nextAfterCodeAccepted(challenge), 'wait-for-dob');
  assert.equal(nextAfterCodeAccepted({ pathname: '/extracare/home', text: 'Card ending in: 6145' }), 'verify-identity');

  const status = dobHandoffStatus('joshua@creditandjourney.com');
  assert.match(status, /open Chrome window/);
  assert.match(status, /date of birth/i);
  assert.doesNotMatch(status, /\b\d{8}\b/);
  assert.doesNotMatch(status, /\d{2}\/\d{2}\/\d{4}/);
  assert.equal(status.includes('1990'), false);
});
