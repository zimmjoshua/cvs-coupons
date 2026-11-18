import assert from 'node:assert/strict';
import test from 'node:test';
import { withSyncLock } from '../src/syncLock.js';

function fakePool(locked) {
  const calls = [];
  return {
    calls,
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
          return { rows: [] };
        },
        release() { calls.push('release'); },
      };
    },
  };
}

test('only one mailbox check holds the postgres lock', async () => {
  let ran = 0;
  const held = fakePool(true);
  const result = await withSyncLock(held, async () => {
    ran += 1;
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(ran, 1);
  assert.equal(held.calls.some((sql) => sql.includes('pg_advisory_unlock')), true);

  const busy = fakePool(false);
  let skipped = 0;
  const overlap = await withSyncLock(busy, async () => {
    skipped += 1;
    return { ok: true };
  });
  assert.equal(overlap.skipped, 'overlap');
  assert.equal(skipped, 0);
});

function poolThatFailsUnlock() {
  const released = [];
  return {
    released,
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          if (sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
          return { rows: [] };
        },
        release(error) {
          released.push(error ? 'destroyed' : 'returned');
        },
      };
    },
  };
}

test('a failed unlock destroys the client and still returns the sync result', async () => {
  const pool = poolThatFailsUnlock();
  const result = await withSyncLock(pool, async () => ({ imported: 2, label: 'CVS' }));
  assert.deepEqual(result, { imported: 2, label: 'CVS' });
  assert.deepEqual(pool.released, ['destroyed']);
});

test('a failed unlock does not hide a sync error', async () => {
  const pool = poolThatFailsUnlock();
  await assert.rejects(
    () => withSyncLock(pool, async () => {
      throw new Error('sync failed');
    }),
    /sync failed/,
  );
  assert.deepEqual(pool.released, ['destroyed']);
});
