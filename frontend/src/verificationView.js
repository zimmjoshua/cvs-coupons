const EXPIRED = 'That code check expired. Start waiting again, then click Send code.';

export function nextVerification(current, event = {}) {
  if (event.type === 'cancel' || event.type === 'navigate') return null;
  const couponId = event.couponId || current?.couponId || '';
  const accountEmail = event.accountEmail || current?.accountEmail || '';
  if (event.type === 'starting') {
    return {
      couponId,
      accountEmail,
      sessionId: '',
      status: 'starting',
      code: '',
      expiresAt: '',
      message: '',
    };
  }
  if (event.type === 'waiting' || event.type === 'retrying') {
    return {
      couponId,
      accountEmail,
      sessionId: event.sessionId || current?.sessionId || '',
      status: event.type,
      code: '',
      startedAt: event.startedAt || current?.startedAt || '',
      expiresAt: event.expiresAt || current?.expiresAt || '',
      lastCheckedAt: event.lastCheckedAt || current?.lastCheckedAt || '',
      message: event.message || '',
    };
  }
  if (event.type === 'resume') {
    const now = Number.isFinite(event.now) ? event.now : Date.now();
    const end = Date.parse(current?.expiresAt || '');
    if (!current?.sessionId || (Number.isFinite(end) && now >= end)) {
      return {
        couponId,
        accountEmail,
        sessionId: '',
        status: 'expired',
        code: '',
        expiresAt: '',
        startedAt: current?.startedAt || '',
        message: event.message || EXPIRED,
      };
    }
    return { ...current };
  }
  if (event.type === 'copy') {
    const now = Number.isFinite(event.now) ? event.now : Date.now();
    const end = Date.parse(current?.expiresAt || '');
    if (!current?.code || current.status !== 'ready' || (Number.isFinite(end) && now >= end)) {
      return {
        couponId,
        accountEmail,
        sessionId: '',
        status: 'expired',
        code: '',
        expiresAt: '',
        startedAt: current?.startedAt || '',
        message: EXPIRED,
      };
    }
    return { ...current };
  }
  if (event.type === 'expired' || event.type === 'ended') {
    return {
      couponId,
      accountEmail,
      sessionId: '',
      status: 'expired',
      code: '',
      expiresAt: '',
      message: event.message || EXPIRED,
    };
  }
  if (event.type === 'error') {
    return {
      couponId,
      accountEmail,
      sessionId: '',
      status: 'error',
      code: '',
      expiresAt: '',
      message: event.message || 'The mailbox could not be checked.',
    };
  }
  if (event.type === 'ready') {
    const end = Date.parse(event.expiresAt || '');
    const now = Number.isFinite(event.now) ? event.now : Date.now();
    if (!event.code || (Number.isFinite(end) && now >= end)) {
      return {
        couponId,
        accountEmail,
        sessionId: '',
        status: 'expired',
        code: '',
        expiresAt: '',
        message: EXPIRED,
      };
    }
    return {
      couponId,
      accountEmail,
      sessionId: event.sessionId || current?.sessionId || '',
      status: 'ready',
      code: String(event.code),
      startedAt: event.startedAt || current?.startedAt || '',
      lastCheckedAt: event.lastCheckedAt || current?.lastCheckedAt || '',
      expiresAt: event.expiresAt || '',
      message: '',
    };
  }
  return current ? { ...current, code: '' } : null;
}

export const VERIFICATION_REQUEST_MS = 25000;

export function shouldPollVerification(status) {
  return status === 'starting' || status === 'waiting' || status === 'retrying';
}

export function openVerificationRequest(work, { timeoutMs = VERIFICATION_REQUEST_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fail = () => {
    const error = new Error('The mailbox check timed out.');
    error.name = 'AbortError';
    return error;
  };
  let rejectAbort = () => {};
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(fail());
  if (controller.signal.aborted) onAbort();
  else controller.signal.addEventListener('abort', onAbort, { once: true });
  const job = Promise.resolve().then(() => work(controller.signal));
  const request = Promise.race([job, aborted]).finally(() => {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  });
  aborted.catch(() => {});
  job.catch(() => {});
  return {
    request,
    abort() {
      controller.abort();
    },
  };
}
