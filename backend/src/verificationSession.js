import crypto from 'node:crypto';
import { otpReadableInMailbox } from './accountIdentity.js';
import { isReauthError } from './syncOffers.js';

export const VERIFICATION_SESSION_MS = 10 * 60 * 1000;
export const VERIFICATION_DISPLAY_MS = 3 * 60 * 1000;
export const VERIFICATION_START_COOLDOWN_MS = 5000;
export const VERIFICATION_POLL_COOLDOWN_MS = 2000;
export const VERIFICATION_MAX_BACKOFF_MS = 20 * 1000;
export const VERIFICATION_READ_TIMEOUT_MS = 20 * 1000;
const START_WINDOW_MS = 10 * 60 * 1000;
const START_WINDOW_MAX = 6;

function mailboxAddress(mailbox) {
  const value = typeof mailbox === 'function' ? mailbox() : mailbox;
  return String(value || '').trim().toLowerCase();
}

function reasonList(error) {
  return [error?.reason, ...(error?.reasons || [])].map((value) => String(value || ''));
}

export function isTransientVerificationError(error) {
  if (error?.code === 'label_missing' || isReauthError(error)) return false;
  const reasons = reasonList(error);
  if (reasons.some((reason) => reason === 'domainPolicy')) return false;
  if (reasons.some((reason) => reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')) return true;
  const status = Number(error?.status);
  if (status === 401 || status === 403) return false;
  if (status === 429 || status >= 500) return true;
  const name = String(error?.name || '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = String(error?.code || '');
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)) return true;
  return /network|fetch failed|timed out|timeout|socket/i.test(String(error?.message || ''));
}

export function retryDelayMs(error, attempt, remainingMs = Infinity) {
  const remaining = Number.isFinite(Number(remainingMs)) ? Math.max(0, Number(remainingMs)) : Infinity;
  const header = Number(error?.retryAfterMs);
  if (Number.isFinite(header) && header > 0) return Math.min(header, remaining);
  const step = Math.min(Math.max(Number(attempt) || 1, 1), 4);
  return Math.min(VERIFICATION_MAX_BACKOFF_MS, 2000 * 2 ** (step - 1), remaining);
}

export function verificationReadError(error) {
  if (error?.code === 'label_missing') {
    return { status: 409, body: { status: 'error', error: error.message } };
  }
  if (isReauthError(error)) {
    return { status: 409, body: { status: 'error', error: 'Gmail needs to be signed in again. This check will not open a Google prompt.' } };
  }
  return { status: 502, body: { status: 'error', error: 'The mailbox could not be checked.' } };
}

function readOutcome(result) {
  if (result && typeof result === 'object') {
    const delivery = result.delivery?.receivedAt ? { receivedAt: result.delivery.receivedAt } : null;
    return { code: result.code ? String(result.code) : '', delivery };
  }
  return { code: result ? String(result) : '', delivery: null };
}

function abortedReadError() {
  const error = new Error('The mailbox check timed out.');
  error.name = 'AbortError';
  return error;
}

export function createVerificationHub({
  now = () => Date.now(),
  readCode,
  mailbox,
  randomId = () => crypto.randomBytes(16).toString('hex'),
  readTimeoutMs = VERIFICATION_READ_TIMEOUT_MS,
} = {}) {
  const sessions = new Map();
  const starts = new Map();

  function purge(at, keepId) {
    for (const [id, session] of sessions) {
      if (id === keepId) continue;
      if (session.expiresAt <= at) sessions.delete(id);
    }
  }

  function expiredBody() {
    return {
      status: 200,
      body: { status: 'expired', error: 'That code check expired. Start waiting again, then request a new code.' },
    };
  }

  function progressBody(session, status, at) {
    const body = {
      status,
      sessionId: session.id,
      couponId: session.couponId,
      accountEmail: session.accountEmail,
      startedAt: new Date(session.startedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      lastCheckedAt: session.lastCheckedAt ? new Date(session.lastCheckedAt).toISOString() : null,
    };
    if (session.lastDelivery?.receivedAt) body.lastDelivery = { receivedAt: session.lastDelivery.receivedAt };
    if (status === 'retrying') {
      body.retryAfterMs = Math.max(0, (session.nextReadAt || at) - at);
      body.message = 'The mailbox check will try again. The email can take several minutes. You do not need to restart this wait.';
    }
    return body;
  }

  return {
    start({ coupon, at = now() } = {}) {
      purge(at);
      if (!coupon?.id) return { status: 404, body: { error: 'Coupon not found.' } };
      const account = String(coupon.cvsAccountEmail || '').trim().toLowerCase();
      if (!account) {
        return { status: 400, body: { error: 'This offer has no CVS account email, so a verification code cannot be matched.' } };
      }
      if (!otpReadableInMailbox(account, mailboxAddress(mailbox))) {
        return {
          status: 400,
          body: {
            error: `Verification email for ${account} is not delivered to the connected mailbox. This app only reads codes for addresses at the same domain. Use that account's own inbox for the code.`,
          },
        };
      }
      const recent = (starts.get(coupon.id) || []).filter((time) => at - time < START_WINDOW_MS);
      const last = recent.at(-1) || 0;
      if (last && at - last < VERIFICATION_START_COOLDOWN_MS) {
        return { status: 429, body: { error: 'Wait a few seconds before starting another code check.' } };
      }
      if (recent.length >= START_WINDOW_MAX) {
        return { status: 429, body: { error: 'Too many code checks. Wait a few minutes and try again.' } };
      }
      for (const [id, session] of sessions) {
        if (session.couponId === coupon.id) sessions.delete(id);
      }
      const session = {
        id: randomId(),
        couponId: coupon.id,
        accountEmail: account,
        startedAt: at,
        waitUntil: at + VERIFICATION_SESSION_MS,
        expiresAt: at + VERIFICATION_SESSION_MS,
        lastCheckedAt: 0,
        nextReadAt: 0,
        reading: false,
        transientAttempt: 0,
        skippedIds: [],
      };
      sessions.set(session.id, session);
      recent.push(at);
      starts.set(coupon.id, recent);
      return { status: 201, body: progressBody(session, 'waiting', at) };
    },

    async poll({ couponId, sessionId, at = now() } = {}) {
      purge(at, sessionId);
      const session = sessions.get(sessionId);
      if (!session || session.couponId !== couponId) {
        return { status: 404, body: { error: 'That code check has ended.' } };
      }
      if (session.expiresAt <= at || (session.displayUntil && session.displayUntil <= at)) {
        sessions.delete(sessionId);
        return expiredBody();
      }
      if (session.heldCode && session.displayUntil > at) {
        return {
          status: 200,
          body: {
            ...progressBody(session, 'ready', at),
            code: session.heldCode,
            expiresAt: new Date(session.displayUntil).toISOString(),
          },
        };
      }
      if (session.reading || (session.nextReadAt && at < session.nextReadAt)) {
        const status = session.transientAttempt || session.resumePageToken ? 'retrying' : 'waiting';
        return { status: 200, body: progressBody(session, status, at) };
      }
      session.reading = true;
      session.readGeneration = (session.readGeneration || 0) + 1;
      const generation = session.readGeneration;
      const controller = new AbortController();
      session.abortRead = () => controller.abort();
      const remaining = Math.max(0, session.waitUntil - at);
      const budget = Math.min(readTimeoutMs, remaining);
      const abortForDeadline = remaining <= readTimeoutMs;
      let rejectAbort = () => {};
      const abortPromise = new Promise((_, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => rejectAbort(abortedReadError());
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), budget);
      const readPromise = Promise.resolve().then(() => readCode({
        expectedRecipient: session.accountEmail,
        afterMs: session.startedAt,
        skipIds: session.skippedIds,
        pageToken: session.resumePageToken || '',
        signal: controller.signal,
      }));
      const ended = () => ({ status: 404, body: { error: 'That code check has ended.' } });
      try {
        const result = await Promise.race([readPromise, abortPromise]);
        const live = sessions.get(sessionId);
        if (!live || live.readGeneration !== generation || live.couponId !== couponId || controller.signal.aborted) {
          if (!live || live.readGeneration !== generation || live.couponId !== couponId) return ended();
          if (abortForDeadline || live.waitUntil <= now()) {
            sessions.delete(sessionId);
            return expiredBody();
          }
          throw abortedReadError();
        }
        const finishedAt = now();
        const outcome = readOutcome(result);
        if (Array.isArray(result?.skippedIds)) {
          live.skippedIds = [...new Set([...(live.skippedIds || []), ...result.skippedIds])];
        }
        live.lastCheckedAt = finishedAt;
        live.transientAttempt = 0;
        live.nextReadAt = finishedAt + VERIFICATION_POLL_COOLDOWN_MS;
        if (outcome.delivery) live.lastDelivery = outcome.delivery;
        if (finishedAt >= live.waitUntil) {
          sessions.delete(sessionId);
          return expiredBody();
        }
        if (result && result.complete === false && !outcome.code) {
          live.resumePageToken = result.pageToken || '';
          return {
            status: 200,
            body: {
              ...progressBody(live, 'retrying', finishedAt),
              message: 'Still checking the CVS label. You do not need to restart this wait.',
            },
          };
        }
        live.resumePageToken = '';
        if (!outcome.code) return { status: 200, body: progressBody(live, 'waiting', finishedAt) };
        live.heldCode = outcome.code;
        live.displayUntil = finishedAt + VERIFICATION_DISPLAY_MS;
        live.expiresAt = live.displayUntil;
        return {
          status: 200,
          body: {
            ...progressBody(live, 'ready', finishedAt),
            code: live.heldCode,
            expiresAt: new Date(live.displayUntil).toISOString(),
          },
        };
      } catch (error) {
        const live = sessions.get(sessionId);
        const finishedAt = now();
        if (!live || live.readGeneration !== generation || live.couponId !== couponId) return ended();
        if ((controller.signal.aborted && abortForDeadline) || finishedAt >= live.waitUntil) {
          sessions.delete(sessionId);
          return expiredBody();
        }
        if (!isTransientVerificationError(error)) {
          sessions.delete(sessionId);
          return verificationReadError(error);
        }
        live.transientAttempt += 1;
        const retryRemaining = live.waitUntil - finishedAt;
        live.nextReadAt = finishedAt + retryDelayMs(error, live.transientAttempt, retryRemaining);
        return { status: 200, body: progressBody(live, 'retrying', finishedAt) };
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        abortPromise.catch(() => {});
        readPromise.catch(() => {});
        const live = sessions.get(sessionId);
        if (live && live.readGeneration === generation) {
          live.reading = false;
          live.abortRead = null;
        }
      }
    },

    cancel({ couponId, sessionId } = {}) {
      const session = sessions.get(sessionId);
      if (!session || session.couponId !== couponId) {
        return { status: 404, body: { error: 'That code check has ended.' } };
      }
      session.readGeneration = (session.readGeneration || 0) + 1;
      session.abortRead?.();
      sessions.delete(sessionId);
      return { status: 204, body: null };
    },

    sessionRecords() {
      return [...sessions.values()].map((session) => ({
        id: session.id,
        couponId: session.couponId,
        accountEmail: session.accountEmail,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        lastCheckedAt: session.lastCheckedAt || null,
        lastDelivery: session.lastDelivery || null,
      }));
    },
  };
}
