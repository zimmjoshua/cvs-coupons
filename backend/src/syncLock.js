export const SYNC_LOCK_KEY = 740021;

export async function withSyncLock(pool, work) {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [SYNC_LOCK_KEY]);
    locked = Boolean(result.rows[0]?.locked);
    if (!locked) return { skipped: 'overlap' };
    return await work();
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_KEY]);
        try {
          client.release();
        } catch {
          // Returning the client failed after the lock was released. Keep the sync result.
        }
      } catch (error) {
        try {
          client.release(error);
        } catch {
          // The connection is already unusable. Dropping it must not replace the sync result.
        }
      }
    } else {
      try {
        client.release();
      } catch {
        // The unused client could not return to the pool.
      }
    }
  }
}
