import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectMessageIds,
  normalizeSyncState,
  PARSER_VERSION,
  runMailboxSync,
  shouldOpenOAuth,
  startSyncLoop,
} from '../src/syncOffers.js';
import { missingLabelError } from '../src/gmailQuery.js';

const now = '2026-11-18T20:00:00.000Z';

function offerFor(id, email = 'shopper@creditandjourney.com') {
  return {
    id: `offer-${id}`,
    messageId: id,
    amount: 4,
    expiresOn: '2026-11-25',
    cardLast4: email.startsWith('shopper') ? '6145' : '0289',
    cvsAccountEmail: email,
    otpReadable: email.endsWith('@creditandjourney.com'),
    couponUrl: 'https://www.cvs.com/extracare/home',
  };
}

function memoryStore(seed = []) {
  const rows = new Map(seed.map((offer) => [offer.id, offer]));
  return {
    rows,
    async upsert(offer) {
      if (rows.has(offer.id)) {
        rows.set(offer.id, { ...rows.get(offer.id), ...offer });
        return 'already';
      }
      rows.set(offer.id, offer);
      return 'imported';
    },
  };
}

function pagesOf(ids, size, historyId = 'h1') {
  return async ({ pageToken, maxResults }) => {
    const start = pageToken ? Number(pageToken) : 0;
    const slice = ids.slice(start, start + maxResults);
    const next = start + maxResults < ids.length ? String(start + maxResults) : '';
    return {
      messages: slice.map((id) => ({ id })),
      nextPageToken: next,
      historyId: start === 0 ? historyId : null,
    };
  };
}

test('pages past five messages and keeps a later message on the next poll', async () => {
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
  const collected = await collectMessageIds({ pageSize: 5, listPage: pagesOf(ids, 5), checkpoint: {} });
  assert.deepEqual(collected.ids, ids);
  assert.equal(collected.mode, 'full');

  const store = memoryStore();
  const first = await runMailboxSync({
    now,
    state: null,
    intervalMs: 60000,
    pageSize: 5,
    listPage: pagesOf(ids, 5),
    readOffers: async (id) => [offerFor(id)],
    upsert: store.upsert,
    openInteractive: () => { throw new Error('oauth opened'); },
  });
  assert.equal(first.imported, 7);
  assert.equal(store.rows.get('offer-m7').cvsAccountEmail, 'shopper@creditandjourney.com');
  assert.equal(store.rows.get('offer-m7').cardLast4, '6145');

  let fullScans = 0;
  const second = await runMailboxSync({
    now: '2026-11-18T20:01:00.000Z',
    state: first,
    intervalMs: 60000,
    pageSize: 5,
    historyPage: async ({ pageToken }) => {
      if (pageToken) return { historyId: 'h3', history: [{ messagesAdded: [{ message: { id: 'm9' } }] }], nextPageToken: '' };
      return { historyId: 'h2', history: [{ messagesAdded: [{ message: { id: 'm8' } }] }], nextPageToken: 'next' };
    },
    listPage: () => { fullScans += 1; throw new Error('full scan should not run when history is current'); },
    readOffers: async (id) => [offerFor(id, id === 'm8' ? 'deals@creditandjourney.com' : 'shopper@creditandjourney.com')],
    upsert: store.upsert,
  });
  assert.equal(fullScans, 0);
  assert.equal(second.imported, 2);
  assert.equal(store.rows.size, 9);
  assert.equal(store.rows.get('offer-m8').cvsAccountEmail, 'deals@creditandjourney.com');
  assert.equal(store.rows.get('offer-m1').cardLast4, '6145');
});

test('an expired history cursor falls back to every page', async () => {
  const expired = new Error('Requested entity was not found.');
  expired.status = 404;
  const collected = await collectMessageIds({
    pageSize: 5,
    checkpoint: { historyId: 'old' },
    historyPage: async () => { throw expired; },
    listPage: pagesOf(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], 5),
  });
  assert.equal(collected.mode, 'full');
  assert.deepEqual(collected.ids, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
});

test('restart and duplicate polls do not create a second offer', async () => {
  const store = memoryStore();
  const listPage = pagesOf(['m1', 'm2'], 5);
  const first = await runMailboxSync({
    now,
    state: null,
    listPage,
    readOffers: async (id) => [offerFor(id)],
    upsert: store.upsert,
  });
  const restored = normalizeSyncState(JSON.parse(JSON.stringify(first)));
  assert.equal(restored.running, false);
  const second = await runMailboxSync({
    now: '2026-11-18T20:01:00.000Z',
    state: { ...restored, running: true },
    listPage: () => { throw new Error('should not list while running'); },
    readOffers: async () => [],
    upsert: store.upsert,
  });
  assert.equal(second.skipped, 'overlap');
  const third = await runMailboxSync({
    now: '2026-11-18T20:02:00.000Z',
    state: restored,
    listPage,
    readOffers: async (id) => [offerFor(id)],
    upsert: store.upsert,
  });
  assert.equal(third.imported, 0);
  assert.equal(store.rows.size, 2);
});

test('token failure is visible, backs off, and does not open OAuth', async () => {
  let opened = 0;
  const store = memoryStore([offerFor('m1')]);
  const failed = await runMailboxSync({
    now,
    state: { lastSuccess: '2026-11-18T19:00:00.000Z', processedMessageIds: ['m1'], historyId: 'h1', parserVersion: PARSER_VERSION },
    intervalMs: 60000,
    historyPage: async () => {
      const error = new Error('invalid_grant');
      error.oauthError = 'invalid_grant';
      throw error;
    },
    listPage: () => { throw new Error('full scan should not run after invalid_grant'); },
    readOffers: async () => [],
    upsert: store.upsert,
    openInteractive: () => { opened += 1; },
  });
  assert.equal(opened, 0);
  assert.equal(shouldOpenOAuth({ interactive: false, oauthError: 'invalid_grant' }), false);
  assert.equal(failed.needsReauthentication, true);
  assert.match(failed.lastError, /needs to be signed in again/);
  assert.match(failed.lastError, /7 days/);
  assert.equal(failed.lastSuccess, '2026-11-18T19:00:00.000Z');
  assert.ok(Date.parse(failed.nextPoll) - Date.parse(now) >= 60000);

  const recovered = await runMailboxSync({
    now: '2026-11-18T20:05:00.000Z',
    state: failed,
    pageSize: 5,
    listPage: pagesOf(['m1', 'm2'], 5, 'h9'),
    readOffers: async (id) => [offerFor(id)],
    upsert: store.upsert,
  });
  assert.equal(recovered.needsReauthentication, false);
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.imported, 1);
  assert.equal(store.rows.size, 2);
});

test('a mailbox check does not queue barcode capture', async () => {
  const result = await runMailboxSync({
    now,
    state: { parserVersion: PARSER_VERSION },
    listPage: pagesOf(['m1'], 5),
    readOffers: async (id) => [offerFor(id)],
    upsert: async () => 'imported',
  });
  assert.deepEqual(result.capture, {});
});

test('reads the CVS label, including mail labeled later, without using the inbox', async () => {
  const store = memoryStore();
  const listed = [];
  const first = await runMailboxSync({
    now,
    state: { parserVersion: PARSER_VERSION },
    pageSize: 5,
    listPage: async (query) => {
      listed.push(query);
      return {
        labelId: 'Label_9',
        historyId: 'h1',
        messages: [{ id: 'old' }, { id: 'note' }],
        nextPageToken: '',
      };
    },
    readOffers: async (id) => (id === 'note' ? [] : [{ ...offerFor(id), qualifier: 'off your entire purchase' }]),
    upsert: store.upsert,
  });
  assert.equal(listed[0].pageToken, '');
  assert.equal(first.label.found, true);
  assert.equal(first.label.id, 'Label_9');
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get('offer-old').cvsAccountEmail, 'shopper@creditandjourney.com');

  const second = await runMailboxSync({
    now: '2026-11-18T20:01:00.000Z',
    state: first,
    historyPage: async () => ({
      labelId: 'Label_9',
      historyId: 'h2',
      history: [{ labelsAdded: [{ message: { id: 'fresh' }, labelIds: ['Label_9'] }] }],
      nextPageToken: '',
    }),
    listPage: () => { throw new Error('inbox scan should not run'); },
    readOffers: async (id) => [offerFor(id, 'deals@creditandjourney.com')],
    upsert: store.upsert,
  });
  assert.equal(second.imported, 1);
  assert.equal(store.rows.size, 2);
  assert.equal(store.rows.get('offer-fresh').cvsAccountEmail, 'deals@creditandjourney.com');

  const third = await runMailboxSync({
    now: '2026-11-18T20:02:00.000Z',
    state: second,
    historyPage: async () => ({ labelId: 'Label_9', historyId: 'h3', history: [], nextPageToken: '' }),
    listPage: () => { throw new Error('inbox scan should not run'); },
    readOffers: async () => [],
    upsert: store.upsert,
  });
  assert.equal(third.imported, 0);
  assert.equal(store.rows.size, 2);
});

test('a missing CVS label is visible and does not fall back to the inbox', async () => {
  let listed = 0;
  const failed = await runMailboxSync({
    now,
    state: { parserVersion: PARSER_VERSION, historyId: 'h1', lastSuccess: '2026-11-18T19:00:00.000Z' },
    historyPage: async () => { throw missingLabelError('CVS'); },
    listPage: async () => { listed += 1; return { messages: [] }; },
    readOffers: async () => [],
    upsert: async () => 'imported',
  });
  assert.equal(listed, 0);
  assert.equal(failed.label.found, false);
  assert.equal(failed.needsReauthentication, false);
  assert.match(failed.lastError, /Gmail label CVS was not found/);
  assert.equal(failed.lastSuccess, '2026-11-18T19:00:00.000Z');
});

test('one rescan refreshes terms without a second coupon row', async () => {
  const store = memoryStore([{ ...offerFor('m1'), qualifier: 'off a $4 purchase' }]);
  const result = await runMailboxSync({
    now,
    state: {
      parserVersion: 1,
      historyId: 'h1',
      processedMessageIds: ['m1'],
      label: { name: 'CVS', id: 'Label_9', found: true },
    },
    listPage: async () => ({
      labelId: 'Label_9',
      historyId: 'h4',
      messages: [{ id: 'm1' }],
      nextPageToken: '',
    }),
    historyPage: () => { throw new Error('history should wait until the rescan finishes'); },
    readOffers: async () => [{ ...offerFor('m1'), qualifier: 'off your entire purchase' }],
    upsert: store.upsert,
  });
  assert.equal(result.rescanned, true);
  assert.equal(result.parserVersion, PARSER_VERSION);
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get('offer-m1').qualifier, 'off your entire purchase');
  assert.equal(store.rows.get('offer-m1').cardLast4, '6145');
});

test('the loop runs at startup and schedules the next check', async () => {
  const saved = [];
  let runs = 0;
  const loop = startSyncLoop({
    loadState: async () => saved.at(-1) || null,
    saveState: async (state) => { saved.push(state); },
    runOnce: async (state) => {
      runs += 1;
      return runMailboxSync({
        now,
        state,
        intervalMs: 60000,
        listPage: pagesOf(['m1'], 5),
        readOffers: async (id) => [offerFor(id)],
        upsert: async () => 'imported',
      });
    },
    clock: () => Date.parse(now),
    setTimer: (fn, ms) => {
      assert.equal(ms, 60000);
      assert.equal(typeof fn, 'function');
      return 1;
    },
    clearTimer: () => {},
  });
  await loop.ready;
  loop.stop();
  assert.equal(runs, 1);
  assert.equal(saved[0].lastSuccess, now);
  assert.equal(saved[0].running, false);
});
