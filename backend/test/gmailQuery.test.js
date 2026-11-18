import assert from 'node:assert/strict';
import test from 'node:test';
import { couponHistoryParams, couponListParams, findLabel, GMAIL_SCOPE, verificationListParams } from '../src/gmailQuery.js';
import { couponUrlAllowed } from '../src/urls.js';
import { openCouponUrl } from '../src/imageAttach.js';

test('the Gmail scope stays read-only and the CVS label is addressed by id', () => {
  assert.equal(GMAIL_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(GMAIL_SCOPE.includes('gmail.modify'), false);
  const params = couponListParams({ labelId: 'Label_9', maxResults: 5 });
  assert.deepEqual(params.labelIds, ['Label_9']);
  assert.equal('q' in params, false);
  assert.equal(JSON.stringify(params).includes('in:inbox'), false);
  const history = couponHistoryParams({ labelId: 'Label_9', startHistoryId: '44', maxResults: 5 });
  assert.equal(history.labelId, 'Label_9');
  assert.deepEqual(history.historyTypes, ['messageAdded', 'labelAdded']);
  assert.equal(findLabel([{ id: 'Label_1', name: 'Inbox' }, { id: 'Label_9', name: 'CVS' }]).id, 'Label_9');
  assert.equal(findLabel([{ id: 'Label_1', name: 'Inbox' }]), null);
  const afterMs = Date.parse('2026-11-18T21:19:00Z');
  const verification = verificationListParams({ labelId: 'Label_9', maxResults: 15, afterMs });
  assert.deepEqual(verification.labelIds, ['Label_9']);
  assert.equal(verification.q.includes('from:info@alerts.cvs.com'), true);
  assert.equal(verification.q.includes('verification code'), true);
  assert.equal(verification.q.includes(`after:${Math.floor(afterMs / 1000) - 1}`), true);
  assert.equal(/\bafter:\d{4}\//.test(verification.q), false);
  assert.equal(verification.q.includes('in:inbox'), false);
});

test('coupon links stay on the original CVS url and do not gain sign-in fields', () => {
  const original = 'https://click.web.cvs.com/?qs=offer';
  const opened = openCouponUrl(original);
  const url = new URL(opened);
  assert.equal(couponUrlAllowed(original), true);
  assert.equal(opened, original);
  assert.deepEqual([...url.searchParams.keys()], ['qs']);
  for (const key of ['email', 'dob', 'password', 'otp', 'token', 'access_token']) {
    assert.equal(url.searchParams.has(key), false);
  }
  assert.equal(openCouponUrl('https://example.com/coupon'), '');
});
