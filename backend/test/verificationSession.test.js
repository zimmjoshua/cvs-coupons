import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import express from 'express';
import { verificationMatches } from '../src/accountIdentity.js';
import { requireBearer } from '../src/access.js';
import { collectLabelVerification, matchLabelVerification, previewFromMetadata, runLabelVerificationRead, shouldFetchVerificationBody, VERIFICATION_METADATA_HEADERS } from '../src/verificationMail.js';
import { createVerificationHub, isTransientVerificationError, retryDelayMs, VERIFICATION_DISPLAY_MS, VERIFICATION_POLL_COOLDOWN_MS, VERIFICATION_READ_TIMEOUT_MS, VERIFICATION_SESSION_MS } from '../src/verificationSession.js';
import { verificationRouter } from '../src/verificationRoutes.js';
import { nextVerification, openVerificationRequest, shouldPollVerification } from '../../frontend/src/verificationView.js';

const MAILBOX = 'joshua@creditandjourney.com';
const ACCOUNT = 'shopper@creditandjourney.com';
const OTHER = 'deals@creditandjourney.com';
const COUPON_A = 'a'.repeat(20);
const COUPON_B = 'b'.repeat(20);
const SESSION_A = 'a'.repeat(32);
const SESSION_B = 'b'.repeat(32);
const LABEL = 'Label_cvs';
const STARTED = 1_700_000_000_000;
const FRESH = '135790';
const PREVIOUS = '246801';
const WRONG = '111111';

function phrase(value) {
  return `Your verification code is ${value}.`;
}

test('the in-app label read requires the message time to be at or after the wait', () => {
  const earlier = STARTED - 10_000;
  assert.equal(verificationMatches({
    from: 'info@alerts.cvs.com',
    recipient: ACCOUNT,
    internalDate: earlier,
  }, { expectedRecipient: ACCOUNT, afterMs: STARTED }), true);
  assert.equal(verificationMatches({
    from: 'info@alerts.cvs.com',
    recipient: ACCOUNT,
    internalDate: earlier,
  }, { expectedRecipient: ACCOUNT, afterMs: STARTED, lookbackMs: 0 }), false);
  const messages = [
    {
      labelIds: [LABEL],
      from: 'info@alerts.cvs.com',
      subject: 'Verification code',
      text: phrase(PREVIOUS),
      headers: { to: ACCOUNT },
      internalDate: earlier,
    },
    {
      labelIds: [LABEL],
      from: 'info@alerts.cvs.com',
      subject: 'Verification code',
      text: phrase(WRONG),
      headers: { to: OTHER },
      internalDate: STARTED + 1000,
    },
    {
      labelIds: ['INBOX'],
      from: 'info@alerts.cvs.com',
      subject: 'Verification code',
      text: phrase(FRESH),
      headers: { to: ACCOUNT },
      internalDate: STARTED + 1000,
    },
    {
      labelIds: [LABEL],
      from: 'info@alerts.cvs.com',
      subject: 'A coupon',
      text: `Offer ${FRESH}`,
      headers: { to: ACCOUNT },
      internalDate: STARTED + 1000,
    },
  ];
  const matched = matchLabelVerification(messages, {
    expectedRecipient: ACCOUNT,
    afterMs: STARTED,
    mailbox: MAILBOX,
    labelId: LABEL,
  });
  assert.equal(matched == null, true);
  messages.push({
    labelIds: [LABEL],
    from: 'info@alerts.cvs.com',
    subject: 'Your verification code',
    text: phrase(FRESH),
    headers: { to: ACCOUNT },
    internalDate: STARTED,
  });
  const fresh = matchLabelVerification(messages, {
    expectedRecipient: ACCOUNT,
    afterMs: STARTED,
    mailbox: MAILBOX,
    labelId: LABEL,
  });
  assert.equal(fresh === FRESH, true);
  assert.equal(fresh === PREVIOUS, false);
  assert.equal(fresh === WRONG, false);
});

test('label verification lists the CVS label and does not read mail outside that list', async () => {
  const seen = [];
  const fetched = [];
  const { params, messages } = await collectLabelVerification({
    labelId: LABEL,
    list: async (query) => {
      seen.push(query);
      return { messages: [{ id: 'in-label' }] };
    },
    getMessage: async (id) => {
      fetched.push(id);
      return {
        id,
        labelIds: [LABEL],
        internalDate: STARTED + 500,
      };
    },
    parseMessage: async () => ({
      from: 'info@alerts.cvs.com',
      subject: 'Verification code',
      text: phrase(FRESH),
      headers: { to: ACCOUNT },
    }),
  });
  assert.deepEqual(params.labelIds, [LABEL]);
  assert.equal(params.q.includes('from:info@alerts.cvs.com'), true);
  assert.equal(params.q.includes('in:inbox'), false);
  assert.deepEqual(fetched, ['in-label']);
  assert.equal(seen.length, 1);
  const matched = matchLabelVerification(messages, {
    expectedRecipient: ACCOUNT,
    afterMs: STARTED,
    mailbox: MAILBOX,
    labelId: LABEL,
  });
  assert.equal(matched === FRESH, true);
  const source = fs.readFileSync(new URL('../src/verificationMail.js', import.meta.url), 'utf8');
  assert.equal(source.includes('lookbackMs: 0'), true);
  const reader = fs.readFileSync(new URL('../src/gmail.js', import.meta.url), 'utf8');
  const start = reader.indexOf('export async function readLabelVerificationCode');
  const slice = reader.slice(start, reader.indexOf('export async function syncConnectedMailbox', start));
  assert.equal(slice.includes('interactive: false'), true);
  assert.equal(slice.includes('collectLabelVerification'), true);
  assert.equal(slice.includes('in:inbox'), false);
  assert.equal(slice.includes('runLabelVerificationRead'), true);
  assert.equal(slice.includes('signal: current'), true);
  assert.equal(reader.includes('AbortSignal.timeout(ms)'), true);
  assert.equal(reader.includes('ms = 15000'), true);
  assert.equal(reader.includes('VERIFICATION_METADATA_HEADERS'), true);
});

test('a session stays on its coupon, ignores an outside mailbox, and drops a code that arrives after expiry', async () => {
  let clock = STARTED;
  const calls = [];
  const ids = [SESSION_A, SESSION_B, 'c'.repeat(32)];
  const hub = createVerificationHub({
    now: () => clock,
    mailbox: MAILBOX,
    randomId: () => ids.shift(),
    readCode: async (query) => {
      calls.push(query);
      clock += 1;
      if (query.expectedRecipient === ACCOUNT) return FRESH;
      if (query.expectedRecipient === OTHER) return WRONG;
      return PREVIOUS;
    },
  });
  const outside = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: 'zimmjoshua@gmail.com' } });
  assert.equal(outside.status, 400);
  assert.equal(calls.length, 0);
  const missing = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: '' } });
  assert.equal(missing.status, 400);
  const started = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  assert.equal(started.status, 201);
  assert.equal(Object.hasOwn(started.body, 'code'), false);
  assert.equal(started.body.accountEmail, ACCOUNT);
  const again = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: OTHER } });
  assert.equal(again.status, 429);
  const isolated = await hub.poll({ couponId: COUPON_B, sessionId: started.body.sessionId });
  assert.equal(isolated.status, 404);
  assert.equal(calls.length, 0);
  const ready = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.code === FRESH, true);
  assert.equal(calls[0].expectedRecipient, ACCOUNT);
  assert.equal(calls[0].afterMs, STARTED);
  assert.equal(JSON.stringify(hub.sessionRecords()).includes(FRESH), false);
  const cooled = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(cooled.body.status, 'ready');
  assert.equal(cooled.body.code === FRESH, true);
  assert.equal(calls.length, 1);
  clock = STARTED + 5000;
  const replaced = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  assert.equal(replaced.status, 201);
  assert.equal(replaced.body.sessionId === started.body.sessionId, false);
  const oldPoll = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(oldPoll.status, 404);
  assert.equal(Object.hasOwn(oldPoll.body, 'code'), false);
  const other = hub.start({ coupon: { id: COUPON_B, cvsAccountEmail: OTHER } });
  assert.equal(other.status, 201);
  clock += 2000;
  const otherReady = await hub.poll({ couponId: COUPON_B, sessionId: other.body.sessionId });
  assert.equal(otherReady.body.code === WRONG, true);
  assert.equal(otherReady.body.code === FRESH, false);
  let lateClock = STARTED;
  const lateHub = createVerificationHub({
    now: () => lateClock,
    mailbox: MAILBOX,
    randomId: () => 'e'.repeat(32),
    readCode: async () => {
      lateClock = STARTED + VERIFICATION_SESSION_MS;
      return PREVIOUS;
    },
  });
  const lateStart = lateHub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  const latePoll = await lateHub.poll({ couponId: COUPON_A, sessionId: lateStart.body.sessionId });
  assert.equal(latePoll.body.status, 'expired');
  assert.equal(Object.hasOwn(latePoll.body, 'code'), false);
  assert.equal(JSON.stringify(latePoll.body).includes(PREVIOUS), false);
  assert.equal(JSON.stringify(lateHub.sessionRecords()).includes(PREVIOUS), false);
});

test('verification routes require the owner token and do not store a code', async (t) => {
  let clock = STARTED;
  const calls = [];
  const hub = createVerificationHub({
    now: () => clock,
    mailbox: MAILBOX,
    randomId: () => SESSION_A,
    readCode: async (query) => {
      calls.push(query.expectedRecipient);
      return FRESH;
    },
  });
  const coupons = new Map([
    [COUPON_A, { id: COUPON_A, cvsAccountEmail: ACCOUNT }],
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api', requireBearer('owner-token'));
  app.use('/api', verificationRouter({
    hub,
    getCoupon: async (id) => coupons.get(id) || null,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  async function request(method, path, { token = '', body } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return {
      status: response.status,
      cache: response.headers.get('cache-control') || '',
      body: text ? JSON.parse(text) : null,
    };
  }
  const anonymous = await request('POST', `/api/coupons/${COUPON_A}/verification`);
  assert.equal(anonymous.status, 401);
  assert.equal(JSON.stringify(anonymous.body).includes(FRESH), false);
  const wrong = await request('POST', `/api/coupons/${COUPON_A}/verification`, { token: 'nope' });
  assert.equal(wrong.status, 401);
  const created = await request('POST', `/api/coupons/${COUPON_A}/verification`, {
    token: 'owner-token',
    body: { email: OTHER },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.accountEmail, ACCOUNT);
  assert.equal(Object.hasOwn(created.body, 'code'), false);
  assert.equal(created.cache.includes('no-store'), true);
  const missingCoupon = await request('GET', `/api/coupons/${COUPON_B}/verification/${created.body.sessionId}`, {
    token: 'owner-token',
  });
  assert.equal(missingCoupon.status, 404);
  assert.equal(calls.length, 0);
  clock += 1;
  const polled = await request('GET', `/api/coupons/${COUPON_A}/verification/${created.body.sessionId}`, {
    token: 'owner-token',
  });
  assert.equal(polled.status, 200);
  assert.equal(polled.body.status, 'ready');
  assert.equal(polled.body.code === FRESH, true);
  assert.equal(polled.cache.includes('no-store'), true);
  assert.equal(calls[0], ACCOUNT);
  clock = STARTED + VERIFICATION_SESSION_MS;
  const expired = await request('GET', `/api/coupons/${COUPON_A}/verification/${created.body.sessionId}`, {
    token: 'owner-token',
  });
  assert.equal(expired.body.status, 'expired');
  assert.equal(Object.hasOwn(expired.body, 'code'), false);
});

test('the open coupon clears a shown code on expiry, a ended check, an error, and leaving', () => {
  const expiresAt = new Date(STARTED + 1000).toISOString();
  const shown = nextVerification(null, {
    type: 'ready',
    couponId: COUPON_A,
    accountEmail: ACCOUNT,
    sessionId: SESSION_A,
    expiresAt,
    code: FRESH,
    now: STARTED,
  });
  assert.equal(shown.status, 'ready');
  assert.equal(shown.code === FRESH, true);
  for (const type of ['expired', 'ended', 'error']) {
    const cleared = nextVerification(shown, { type, message: 'That code check has ended.' });
    assert.equal(cleared.code, '');
    assert.equal(cleared.sessionId, '');
    assert.equal(cleared.status === 'ready', false);
    assert.equal(JSON.stringify(cleared).includes(FRESH), false);
  }
  const timed = nextVerification(shown, {
    type: 'ready',
    couponId: COUPON_A,
    accountEmail: ACCOUNT,
    sessionId: SESSION_A,
    expiresAt,
    code: FRESH,
    now: STARTED + 1000,
  });
  assert.equal(timed.status, 'expired');
  assert.equal(timed.code, '');
  assert.equal(nextVerification(shown, { type: 'cancel' }), null);
  assert.equal(nextVerification(shown, { type: 'navigate' }), null);
  const waiting = nextVerification(null, {
    type: 'waiting',
    couponId: COUPON_A,
    accountEmail: ACCOUNT,
    sessionId: SESSION_A,
    startedAt: new Date(STARTED).toISOString(),
    expiresAt: new Date(STARTED + VERIFICATION_SESSION_MS).toISOString(),
  });
  const resumed = nextVerification(waiting, { type: 'resume', now: STARTED + 4 * 60 * 1000 });
  assert.equal(resumed.sessionId, SESSION_A);
  assert.equal(resumed.startedAt, waiting.startedAt);
  assert.equal(resumed.code, '');
  const slept = nextVerification(waiting, { type: 'resume', now: STARTED + VERIFICATION_SESSION_MS });
  assert.equal(slept.status, 'expired');
  assert.equal(slept.code, '');
  const retrying = nextVerification(waiting, {
    type: 'retrying',
    sessionId: SESSION_A,
    startedAt: waiting.startedAt,
    expiresAt: waiting.expiresAt,
  });
  assert.equal(retrying.status, 'retrying');
  assert.equal(retrying.sessionId, SESSION_A);
  const copied = nextVerification(shown, { type: 'copy', now: STARTED });
  assert.equal(copied.status, 'ready');
  assert.equal(copied.code === FRESH, true);
  const lateCopy = nextVerification(shown, { type: 'copy', now: STARTED + 1000 });
  assert.equal(lateCopy.status, 'expired');
  assert.equal(lateCopy.code, '');
});

test('a code that arrives four minutes later stays on the same wait', async () => {
  let clock = STARTED;
  const mailbox = [];
  let reads = 0;
  const hub = createVerificationHub({
    now: () => clock,
    mailbox: MAILBOX,
    randomId: () => SESSION_A,
    readCode: async ({ afterMs, expectedRecipient }) => {
      reads += 1;
      const hit = mailbox.find((item) => item.recipient === expectedRecipient && item.internalDate >= afterMs);
      return hit ? hit.code : '';
    },
  });
  const started = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  clock = STARTED + 60 * 1000;
  const early = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(early.body.status, 'waiting');
  assert.equal(Object.hasOwn(early.body, 'code'), false);
  mailbox.push({ recipient: ACCOUNT, internalDate: STARTED - 1000, code: PREVIOUS });
  clock = STARTED + 4 * 60 * 1000;
  const stale = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(stale.body.status, 'waiting');
  mailbox.push({ recipient: ACCOUNT, internalDate: STARTED + 4 * 60 * 1000, code: FRESH });
  clock += VERIFICATION_POLL_COOLDOWN_MS;
  const ready = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(ready.body.sessionId, started.body.sessionId);
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.code === FRESH, true);
  assert.equal(ready.body.code === PREVIOUS, false);
  assert.equal(Date.parse(ready.body.expiresAt) - clock, VERIFICATION_DISPLAY_MS);
  assert.equal(reads, 3);
  clock += VERIFICATION_DISPLAY_MS;
  const hidden = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(hidden.body.status, 'expired');
  assert.equal(Object.hasOwn(hidden.body, 'code'), false);
});

test('a transient mailbox failure retries on the same session and then recovers', async () => {
  let clock = STARTED;
  let reads = 0;
  const hub = createVerificationHub({
    now: () => clock,
    mailbox: MAILBOX,
    randomId: () => SESSION_A,
    readCode: async () => {
      reads += 1;
      if (reads === 1) {
        const error = new Error('slow down');
        error.status = 429;
        error.retryAfterMs = 5000;
        throw error;
      }
      if (reads === 2) {
        const error = new Error('The mailbox check timed out.');
        error.name = 'TimeoutError';
        throw error;
      }
      return FRESH;
    },
  });
  const started = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  const limited = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(limited.body.status, 'retrying');
  assert.equal(limited.body.sessionId, started.body.sessionId);
  assert.equal(Object.hasOwn(limited.body, 'code'), false);
  clock += 1000;
  const paused = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(paused.body.status, 'retrying');
  assert.equal(reads, 1);
  clock += 5000;
  const timed = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(timed.body.status, 'retrying');
  assert.equal(timed.body.sessionId, started.body.sessionId);
  clock += 4000;
  const ready = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.code === FRESH, true);
  assert.equal(reads, 3);
  assert.equal(isTransientVerificationError({ status: 429, retryAfterMs: 1000 }), true);
  assert.equal(isTransientVerificationError({ status: 503 }), true);
  assert.equal(isTransientVerificationError({ code: 'label_missing' }), false);
  assert.equal(JSON.stringify(hub.sessionRecords()).includes(FRESH), false);
});

test('verification reads page past the first fifteen and skip the wrong alias and older mail', async () => {
  const bodies = [];
  const page = (count, alias, when, token) => Array.from({ length: count }, (_, index) => ({
    id: `${alias}-${when}-${index}`,
    alias,
    when,
    token,
  }));
  const wrong = page(15, OTHER, STARTED + 2000, WRONG);
  const stale = [{ id: 'stale', alias: ACCOUNT, when: STARTED - 5000, token: PREVIOUS }];
  const fresh = [{ id: 'fresh', alias: ACCOUNT, when: STARTED + 4000, token: FRESH }];
  const all = [...wrong, ...stale, ...fresh];
  let cursor = 0;
  const { messages, bodyIds, pages } = await collectLabelVerification({
    labelId: LABEL,
    afterMs: STARTED,
    expectedRecipient: ACCOUNT,
    mailbox: MAILBOX,
    maxResults: 15,
    list: async () => {
      const slice = all.slice(cursor, cursor + 15);
      cursor += 15;
      return { messages: slice.map((item) => ({ id: item.id })), nextPageToken: cursor < all.length ? 'next' : '' };
    },
    getMessage: async (id) => {
      const item = all.find((entry) => entry.id === id);
      return {
        id,
        labelIds: [LABEL],
        internalDate: item.when,
        preview: {
          from: 'info@alerts.cvs.com',
          subject: 'Your verification code',
          internalDate: item.when,
          labelIds: [LABEL],
          headers: { to: item.alias },
        },
      };
    },
    parseMessage: async (message) => {
      const item = all.find((entry) => entry.id === message.id);
      bodies.push(item.id);
      return {
        from: 'info@alerts.cvs.com',
        subject: 'Your verification code',
        text: phrase(item.token),
        headers: { to: item.alias },
      };
    },
  });
  assert.equal(pages, 2);
  assert.deepEqual(bodyIds, ['fresh']);
  assert.deepEqual(bodies, ['fresh']);
  assert.equal(shouldFetchVerificationBody({
    from: 'info@alerts.cvs.com',
    subject: 'Your verification code',
    internalDate: STARTED + 4000,
    labelIds: [LABEL],
    labelId: LABEL,
    afterMs: STARTED,
    expectedRecipient: ACCOUNT,
    headers: { to: OTHER },
    mailbox: MAILBOX,
  }), false);
  const matched = matchLabelVerification(messages, {
    expectedRecipient: ACCOUNT,
    afterMs: STARTED,
    mailbox: MAILBOX,
    labelId: LABEL,
  });
  assert.equal(matched === FRESH, true);
  assert.equal(matched === WRONG, false);
  assert.equal(matched === PREVIOUS, false);
});

test('an in-flight mailbox read does not start a second read', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const hub = createVerificationHub({
    now: () => STARTED,
    mailbox: MAILBOX,
    randomId: () => SESSION_A,
    readCode: () => {
      reads += 1;
      return gate.then(() => FRESH);
    },
  });
  const started = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  const first = hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  const second = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(second.body.status === 'ready', false);
  assert.equal(Object.hasOwn(second.body, 'code'), false);
  assert.equal(reads, 1);
  release();
  const done = await first;
  assert.equal(done.body.status, 'ready');
  assert.equal(done.body.code === FRESH, true);
});

test('metadata keeps an alias that is only in the original recipient headers', () => {
  const message = (name, value) => ({
    id: 'meta',
    internalDate: String(STARTED + 1000),
    labelIds: [LABEL],
    payload: {
      headers: [
        { name: 'From', value: 'CVS <info@alerts.cvs.com>' },
        { name: 'Subject', value: 'Your verification code' },
        { name: 'To', value: MAILBOX },
        { name: 'Delivered-To', value: MAILBOX },
        { name, value },
      ],
    },
  });
  for (const name of ['X-Gm-Original-To', 'Envelope-To', 'X-Original-To']) {
    const preview = previewFromMetadata(message(name, ACCOUNT));
    assert.equal(shouldFetchVerificationBody({
      ...preview,
      labelId: LABEL,
      afterMs: STARTED,
      expectedRecipient: ACCOUNT,
      mailbox: MAILBOX,
    }), true);
  }
  const mailboxOnly = previewFromMetadata({
    id: 'meta',
    internalDate: String(STARTED + 1000),
    labelIds: [LABEL],
    payload: {
      headers: [
        { name: 'From', value: 'info@alerts.cvs.com' },
        { name: 'Subject', value: 'Your verification code' },
        { name: 'To', value: MAILBOX },
      ],
    },
  });
  assert.equal(shouldFetchVerificationBody({
    ...mailboxOnly,
    labelId: LABEL,
    afterMs: STARTED,
    expectedRecipient: ACCOUNT,
    mailbox: MAILBOX,
  }), false);
  for (const name of ['To', 'Delivered-To', 'X-Original-To', 'X-Gm-Original-To', 'Envelope-To']) {
    assert.equal(VERIFICATION_METADATA_HEADERS.includes(name), true);
  }
});

test('an older first page does not hide a later matching message', async () => {
  const calls = [];
  const { bodyIds, complete } = await collectLabelVerification({
    labelId: LABEL,
    afterMs: STARTED,
    expectedRecipient: ACCOUNT,
    mailbox: MAILBOX,
    list: async () => {
      calls.push('list');
      if (calls.length === 1) return { messages: [{ id: 'old' }], nextPageToken: 'rest' };
      return { messages: [{ id: 'fresh' }] };
    },
    getMessage: async (id) => ({
      id,
      labelIds: [LABEL],
      internalDate: id === 'old' ? STARTED - 5000 : STARTED + 1000,
      preview: {
        from: 'info@alerts.cvs.com',
        subject: 'Your verification code',
        internalDate: id === 'old' ? STARTED - 5000 : STARTED + 1000,
        labelIds: [LABEL],
        headers: { to: ACCOUNT },
      },
    }),
    parseMessage: async (message) => ({
      from: 'info@alerts.cvs.com',
      subject: 'Your verification code',
      text: phrase(message.id === 'fresh' ? FRESH : PREVIOUS),
      headers: { to: ACCOUNT },
    }),
  });
  assert.equal(complete, true);
  assert.deepEqual(bodyIds, ['fresh']);
});

test('a capped verification list stays resumable instead of looking empty', async () => {
  let clock = STARTED;
  const seen = [];
  const hub = createVerificationHub({
    now: () => clock,
    mailbox: MAILBOX,
    randomId: () => SESSION_A,
    readCode: async ({ pageToken }) => {
      seen.push(pageToken || '');
      if (!pageToken) return { code: '', complete: false, pageToken: 'rest' };
      return FRESH;
    },
  });
  const started = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  const partial = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(partial.body.status, 'retrying');
  assert.equal(Object.hasOwn(partial.body, 'code'), false);
  clock += 1000;
  const held = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(held.body.status, 'retrying');
  assert.deepEqual(seen, ['']);
  clock += VERIFICATION_POLL_COOLDOWN_MS;
  const ready = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.code === FRESH, true);
  assert.deepEqual(seen, ['', 'rest']);
});

test('Retry-After above 20 seconds waits, and a 403 limit retries without retrying policy or auth', async () => {
  assert.equal(retryDelayMs({ retryAfterMs: 60000 }, 1), 60000);
  assert.equal(retryDelayMs({ retryAfterMs: 60000 }, 1, 10000), 10000);
  assert.equal(retryDelayMs({}, 8) <= 20000, true);
  assert.equal(isTransientVerificationError({ status: 403, reason: 'rateLimitExceeded' }), true);
  assert.equal(isTransientVerificationError({ status: 403, reason: 'userRateLimitExceeded' }), true);
  assert.equal(isTransientVerificationError({ status: 403, reason: 'domainPolicy' }), false);
  assert.equal(isTransientVerificationError({ status: 401, oauthError: 'invalid_grant' }), false);
  let clock = STARTED;
  let reads = 0;
  const hub = createVerificationHub({
    now: () => clock,
    mailbox: MAILBOX,
    randomId: () => SESSION_A,
    readCode: async () => {
      reads += 1;
      if (reads === 1) {
        const error = new Error('slow down');
        error.status = 403;
        error.reason = 'userRateLimitExceeded';
        error.retryAfterMs = 60000;
        throw error;
      }
      return FRESH;
    },
  });
  const started = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  const limited = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(limited.body.status, 'retrying');
  assert.equal(limited.body.startedAt, started.body.startedAt);
  clock += 20000;
  const early = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(early.body.status, 'retrying');
  assert.equal(reads, 1);
  clock += 40000;
  const ready = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(ready.body.status, 'ready');
  assert.equal(reads, 2);
  let lateClock = STARTED + VERIFICATION_SESSION_MS - 10000;
  let lateReads = 0;
  const lateHub = createVerificationHub({
    now: () => lateClock,
    mailbox: MAILBOX,
    randomId: () => SESSION_B,
    readCode: async () => {
      lateReads += 1;
      const error = new Error('slow down');
      error.status = 429;
      error.retryAfterMs = 60000;
      throw error;
    },
  });
  const lateStart = lateHub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT }, at: STARTED });
  const near = await lateHub.poll({ couponId: COUPON_A, sessionId: lateStart.body.sessionId });
  assert.equal(near.body.status, 'retrying');
  lateClock += 5000;
  await lateHub.poll({ couponId: COUPON_A, sessionId: lateStart.body.sessionId });
  assert.equal(lateReads, 1);
  lateClock = STARTED + VERIFICATION_SESSION_MS;
  const ended = await lateHub.poll({ couponId: COUPON_A, sessionId: lateStart.body.sessionId });
  assert.equal(ended.body.status, 'expired');
  assert.equal(lateReads, 1);
  const denied = createVerificationHub({
    now: () => STARTED,
    mailbox: MAILBOX,
    randomId: () => 'd'.repeat(32),
    readCode: async () => {
      const error = new Error('blocked');
      error.status = 403;
      error.reason = 'domainPolicy';
      throw error;
    },
  });
  const deniedStart = denied.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  const stopped = await denied.poll({ couponId: COUPON_A, sessionId: deniedStart.body.sessionId });
  assert.equal(stopped.status, 502);
  const again = await denied.poll({ couponId: COUPON_A, sessionId: deniedStart.body.sessionId });
  assert.equal(again.status, 404);
});

test('a code found near the end of the wait keeps the three minute display', async () => {
  let clock = STARTED;
  const hub = createVerificationHub({
    now: () => clock,
    mailbox: MAILBOX,
    randomId: () => SESSION_A,
    readCode: async () => FRESH,
  });
  const started = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  clock = STARTED + VERIFICATION_SESSION_MS - 1000;
  const ready = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  const shownUntil = Date.parse(ready.body.expiresAt);
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.code === FRESH, true);
  assert.equal(shownUntil - clock, VERIFICATION_DISPLAY_MS);
  assert.equal(shownUntil > STARTED + VERIFICATION_SESSION_MS, true);
  clock = STARTED + VERIFICATION_SESSION_MS;
  const still = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(still.body.status, 'ready');
  assert.equal(still.body.code === FRESH, true);
  assert.equal(Date.parse(still.body.expiresAt), shownUntil);
  const client = nextVerification(null, {
    type: 'ready',
    couponId: COUPON_A,
    accountEmail: ACCOUNT,
    sessionId: started.body.sessionId,
    expiresAt: still.body.expiresAt,
    code: FRESH,
    now: clock,
  });
  assert.equal(client.status, 'ready');
  assert.equal(Date.parse(client.expiresAt), shownUntil);
  assert.equal(nextVerification(client, { type: 'copy', now: clock }).status, 'ready');
  clock = shownUntil;
  const gone = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(gone.body.status, 'expired');
  assert.equal(Object.hasOwn(gone.body, 'code'), false);
  assert.equal(nextVerification(client, { type: 'copy', now: shownUntil }).code, '');
  assert.equal(shouldPollVerification('ready'), false);
  assert.equal(shouldPollVerification('waiting'), true);
  assert.equal(shouldPollVerification('retrying'), true);
});

test('a stalled mailbox read aborts, ignores a late code, and then retries', async () => {
  assert.equal(VERIFICATION_READ_TIMEOUT_MS, 20000);
  let clock = STARTED;
  let attempts = 0;
  let collectCalls = 0;
  let sawAbort = false;
  let releaseLate;
  const hub = createVerificationHub({
    now: () => clock,
    mailbox: MAILBOX,
    randomId: () => SESSION_A,
    readTimeoutMs: 40,
    readCode: ({ signal }) => {
      attempts += 1;
      if (attempts === 1) {
        return runLabelVerificationRead({
          signal,
          prepare: (current) => new Promise((resolve) => {
            current.addEventListener('abort', () => {
              sawAbort = true;
            }, { once: true });
            releaseLate = () => resolve({ token: 'late' });
          }),
          collect: () => {
            collectCalls += 1;
            return { code: PREVIOUS, complete: true };
          },
        });
      }
      return { code: FRESH, complete: true };
    },
  });
  const started = hub.start({ coupon: { id: COUPON_A, cvsAccountEmail: ACCOUNT } });
  const stalled = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(sawAbort, true);
  assert.equal(stalled.body.status, 'retrying');
  assert.equal(stalled.body.sessionId, started.body.sessionId);
  assert.equal(stalled.body.startedAt, started.body.startedAt);
  assert.equal(stalled.body.expiresAt, started.body.expiresAt);
  assert.equal(Object.hasOwn(stalled.body, 'code'), false);
  releaseLate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(collectCalls, 0);
  const during = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(during.body.status, 'retrying');
  assert.equal(Object.hasOwn(during.body, 'code'), false);
  assert.equal(attempts, 1);
  clock += VERIFICATION_POLL_COOLDOWN_MS;
  const ready = await hub.poll({ couponId: COUPON_A, sessionId: started.body.sessionId });
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.code === FRESH, true);
  assert.equal(ready.body.code === PREVIOUS, false);
  assert.equal(attempts, 2);
});

test('pagination stops when the verification read is aborted', async () => {
  const controller = new AbortController();
  let lists = 0;
  await assert.rejects(collectLabelVerification({
    signal: controller.signal,
    labelId: LABEL,
    afterMs: STARTED,
    expectedRecipient: ACCOUNT,
    mailbox: MAILBOX,
    list: () => {
      lists += 1;
      controller.abort();
      return { messages: [{ id: 'one' }], nextPageToken: 'more' };
    },
    getMessage: async () => {
      throw new Error('body read continued after abort');
    },
    parseMessage: async () => {
      throw new Error('parse continued after abort');
    },
  }), (error) => error.name === 'AbortError');
  assert.equal(lists, 1);
});

test('a stalled verification request aborts and a later response does not replace the deadline', async () => {
  let attempts = 0;
  let sawAbort = false;
  let releaseLate;
  const startedAt = new Date(STARTED).toISOString();
  const expiresAt = new Date(STARTED + VERIFICATION_SESSION_MS).toISOString();
  const run = () => openVerificationRequest((signal) => {
    attempts += 1;
    if (attempts === 1) {
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
        }, { once: true });
        releaseLate = () => resolve({
          status: 'ready',
          code: PREVIOUS,
          sessionId: 'stale',
          startedAt: new Date(0).toISOString(),
          expiresAt: new Date(0).toISOString(),
        });
      });
    }
    return { status: 'waiting', sessionId: SESSION_A, startedAt, expiresAt };
  }, { timeoutMs: 40 });
  const first = run();
  await assert.rejects(first.request, (error) => error.name === 'AbortError');
  assert.equal(sawAbort, true);
  let staleApplied = false;
  releaseLate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(staleApplied, false);
  const second = await run().request;
  assert.equal(second.sessionId, SESSION_A);
  assert.equal(second.startedAt, startedAt);
  assert.equal(second.expiresAt, expiresAt);
  assert.equal(second.code, undefined);
});
