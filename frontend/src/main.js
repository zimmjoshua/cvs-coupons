import './styles.css';
import { nextVerification, openVerificationRequest, shouldPollVerification } from './verificationView.js';

const TOKEN_KEY = 'coupon-token';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  unlocked: false,
  coupons: [],
  filter: 'available',
  selectedId: null,
  info: null,
  error: '',
  notice: '',
  scanning: false,
  adding: false,
  draftAmount: 4,
  draftDate: '',
  draftImage: '',
  confirmUse: false,
  offline: false,
  verification: null,
  verificationTimer: null,
  verificationExpiryTimer: null,
  verificationGeneration: 0,
  verificationPolling: false,
};

const app = document.getElementById('app');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function pretty(iso) {
  if (!iso) return '';
  const [year, month, day] = iso.split('-').map(Number);
  const label = `${MONTHS[month - 1]} ${day}`;
  return year === new Date().getFullYear() ? label : `${label}, ${year}`;
}

function expiryText(iso) {
  if (!iso) return 'No expiration found';
  const today = todayISO();
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;
  if (iso < today) return `Expired ${pretty(iso)}`;
  if (iso === today) return 'Expires today';
  if (iso === tomorrow) return 'Expires tomorrow';
  return `Expires ${pretty(iso)}`;
}

function expired(coupon) {
  return Boolean(coupon.expiresOn && coupon.expiresOn < todayISO());
}

function visibleCoupons() {
  return state.coupons
    .filter((coupon) => {
      if (state.filter === 'used') return coupon.status === 'used';
      if (coupon.status === 'used') return false;
      if (state.filter === 'expired') return expired(coupon);
      if (expired(coupon)) return false;
      if (state.filter === '2') return coupon.amount === 2;
      if (state.filter === '4') return coupon.amount === 4;
      return true;
    })
    .sort((a, b) => String(a.expiresOn || '9999').localeCompare(String(b.expiresOn || '9999')));
}

function count(filter) {
  const current = state.filter;
  state.filter = filter;
  const total = visibleCoupons().length;
  state.filter = current;
  return total;
}

function idb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cvs-coupons', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

async function idbSet(key, value) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const request = db.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // The phone can keep working from the latest network response.
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status === 401) {
    state.unlocked = false;
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    throw new Error('Sign in required.');
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(response.status >= 500
        ? 'The server is waking up. Wait a minute and try again.'
        : 'The server sent a response the app could not read.');
    }
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function badge(coupon) {
  if (coupon.status === 'used') return ['used', 'Used'];
  if (expired(coupon)) return ['expired', 'Expired'];
  return ['available', 'Available'];
}

function termsText(coupon) {
  return `$${coupon.amount} ${coupon.qualifier || 'off your purchase'}`;
}

function barcodeNote(coupon) {
  if (coupon.imageKind === 'code') return 'A barcode image is saved. The coupon is still Available, Used, or Expired on its own.';
  if (coupon.hasImage) return 'An image is attached. It does not change the coupon status.';
  return '';
}

function handoffText() {
  return 'Open the coupon in normal Chrome. If CVS asks you to sign in, paste the account email and choose Email. Press Start waiting here before you click Send code. This page shows a code that arrives after that wait starts. The link does not enter the email, the code, or your date of birth.';
}

function elapsedText(value) {
  const start = Date.parse(value || '');
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes} min ${rest} sec` : `${rest} sec`;
}

function clockText(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleString([], { hour: 'numeric', minute: '2-digit' });
}

function syncText() {
  const sync = state.info?.sync;
  if (sync?.needsReauthentication) return sync.lastError || 'Gmail needs to be signed in again.';
  if (sync?.lastError) return `${sync.lastError} Next check ${clockText(sync.nextPoll)}.`;
  if (sync?.lastSuccess) return `Mailbox checked ${clockText(sync.lastSuccess)}. Next check ${clockText(sync.nextPoll)}.`;
  return 'The mailbox is checked automatically.';
}

function render() {
  if (!state.unlocked) {
    app.innerHTML = `
      <p class="eyebrow">ExtraCare</p>
      <h1>Coupons</h1>
      <p class="sub">Coupon inventory from your CVS mail.</p>
      <form class="stack" data-action="unlock">
        <label>Access token
          <input type="password" name="token" autocomplete="current-password" placeholder="From the Render dashboard" required>
        </label>
        <button class="primary" type="submit">Open my coupons</button>
      </form>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}
      <p class="help">The access token stays in this browser and is sent as a header. It is not added to coupon links.</p>
    `;
    return;
  }

  const selected = state.coupons.find((coupon) => coupon.id === state.selectedId);
  if (selected) {
    renderDetail(selected);
    return;
  }

  const coupons = visibleCoupons();
  const chips = [
    ['available', 'Available'],
    ['2', '$2'],
    ['4', '$4'],
    ['used', 'Used'],
    ['expired', 'Expired'],
  ];
  app.innerHTML = `
    <p class="eyebrow">ExtraCare</p>
    <h1>Coupons</h1>
    <p class="sub">${count('available')} available · ${esc(syncText())}</p>
    <p class="help">New coupon emails appear here on their own. Open each coupon in normal Chrome. A sign-in code for an account in this mailbox can show on that coupon. Gmail sign-in is renewed by a person, and background checks do not open Google.</p>
    ${state.offline ? '<p class="banner">Showing the copy saved on this phone. The server is waking up.</p>' : ''}
    ${state.notice ? `<p class="banner">${esc(state.notice)}</p>` : ''}
    ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}
    <div class="chips">
      ${chips.map(([id, label]) => `<button type="button" class="chip" data-action="filter" data-filter="${id}" aria-pressed="${state.filter === id}">${label} ${count(id)}</button>`).join('')}
    </div>
    <div class="list">
      ${coupons.length ? coupons.map(renderCard).join('') : '<p class="empty">No coupons in this view yet. Coupon emails show up here after the mailbox check.</p>'}
    </div>
    ${state.adding ? renderAdd() : ''}
    <div class="actions">
      <button type="button" class="secondary" data-action="add">${state.adding ? 'Close' : 'Add'}</button>
      <button type="button" class="primary" data-action="scan" ${state.scanning ? 'disabled' : ''}>${state.scanning ? 'Scanning…' : 'Scan inbox'}</button>
    </div>
  `;
}

function renderCard(coupon) {
  const [kind, label] = badge(coupon);
  return `
    <article class="card">
      <button type="button" class="card-body" data-action="open" data-id="${esc(coupon.id)}">
        <div>
          <div class="amount"><span>$</span>${coupon.amount}</div>
          <p class="qualifier">${esc(termsText(coupon))}</p>
        </div>
        <span class="badge ${kind}">${label}</span>
        <div class="meta">
          <span>${esc(expiryText(coupon.expiresOn))}</span>
          <span>${coupon.cardLast4 ? `Card ••••${esc(coupon.cardLast4)}` : 'No card'}</span>
          <span>${coupon.cvsAccountEmail ? esc(coupon.cvsAccountEmail) : 'No account'}</span>
          <span>${coupon.subject ? esc(coupon.subject) : ''}</span>
        </div>
      </button>
      ${coupon.couponUrl ? `<a class="open-coupon" href="${esc(coupon.couponUrl)}" target="_blank" rel="noopener noreferrer">Open coupon</a>` : ''}
    </article>
  `;
}

function verificationBlocked(coupon) {
  if (!coupon.cvsAccountEmail) {
    return 'This offer has no CVS account email, so a sign-in code cannot be matched.';
  }
  if (coupon.otpReadable === false) {
    return `Codes for ${coupon.cvsAccountEmail} are not delivered to this mailbox. CVS sends them to that address. This screen cannot show them.`;
  }
  return '';
}

function renderVerification(coupon) {
  const blocked = verificationBlocked(coupon);
  if (blocked) {
    return `<section class="verify"><h2>Sign-in code</h2><p class="help">${esc(blocked)}</p></section>`;
  }
  const current = state.verification?.couponId === coupon.id ? state.verification : null;
  const showCode = Boolean(current?.code) && current.status === 'ready' && Date.parse(current.expiresAt || '') > Date.now();
  const active = current && ['starting', 'waiting', 'ready', 'retrying'].includes(current.status);
  const until = current?.expiresAt ? clockText(current.expiresAt) : '';
  const waited = current?.startedAt ? elapsedText(current.startedAt) : '';
  const checked = current?.lastCheckedAt ? clockText(current.lastCheckedAt) : '';
  let status = 'Press Start waiting here first. Then, in Chrome, choose Email and click Send code. Only a code that arrives after that wait starts is shown. If Send code was already clicked, press Start waiting and click Send code again. Keep this page open.';
  if (current?.status === 'starting') status = `Starting a check for ${coupon.cvsAccountEmail}. Click Send code in Chrome after this starts.`;
  if (current?.status === 'waiting' || current?.status === 'retrying') {
    status = `Waiting for a code to ${coupon.cvsAccountEmail} that arrives after this wait. The email can take several minutes. You do not need to restart this wait.`;
    if (waited) status += ` Waited ${waited}.`;
    if (checked) status += ` Last mailbox check ${checked}.`;
    if (current.status === 'retrying') status += ' Retrying the mailbox check.';
    if (until) status += ` This check ends at ${until}.`;
  }
  if (current?.status === 'ready') status = `Code for ${coupon.cvsAccountEmail}. Paste it into Chrome. The coupon link does not enter it. Press Start again before you click Send code for another email.`;
  if (current?.status === 'expired') status = current.message || 'That code check expired. Start waiting again, then click Send code.';
  if (current?.status === 'error') status = current.message || 'The mailbox could not be checked.';
  return `
    <section class="verify">
      <h2>Sign-in code</h2>
      <p class="help">${esc(status)}</p>
      ${showCode ? `<p class="verification-code">${esc(current.code)}</p>` : ''}
      ${current?.message && current.status !== 'error' && current.status !== 'expired' ? `<p class="help">${esc(current.message)}</p>` : ''}
      <div class="stack">
        ${active ? '' : '<button type="button" class="primary" data-action="verify-start">Start waiting</button>'}
        ${showCode ? '<button type="button" class="secondary" data-action="copy-code">Copy code</button>' : ''}
        ${current?.status === 'ready' ? '<button type="button" class="secondary" data-action="verify-start">Start again</button>' : ''}
        ${current?.sessionId ? '<button type="button" class="text-button" data-action="verify-cancel">Cancel code check</button>' : ''}
      </div>
      <p class="help">Start again before the next Send code. The previous code is cleared. The owner and trusted people share this inventory with one access token. There are no separate accounts.</p>
    </section>
  `;
}

let verificationRequestToken = 0;
let activeVerificationAbort = null;

function abortActiveVerificationRequest() {
  verificationRequestToken += 1;
  state.verificationPolling = false;
  const abort = activeVerificationAbort;
  activeVerificationAbort = null;
  abort?.();
}

function stopVerificationPoll() {
  if (state.verificationTimer) {
    clearInterval(state.verificationTimer);
    state.verificationTimer = null;
  }
}

function clearVerificationClock() {
  if (state.verificationExpiryTimer) {
    clearTimeout(state.verificationExpiryTimer);
    state.verificationExpiryTimer = null;
  }
}

function bumpVerification() {
  state.verificationGeneration += 1;
  return state.verificationGeneration;
}

function dropVerificationSession(current) {
  if (!current?.sessionId || !current.couponId) return;
  api(`/api/coupons/${current.couponId}/verification/${current.sessionId}`, { method: 'DELETE', cache: 'no-store' }).catch(() => {});
}

function armVerificationExpiry(expiresAt) {
  clearVerificationClock();
  const end = Date.parse(expiresAt || '');
  const delay = Number.isFinite(end) ? Math.max(0, end - Date.now()) : 10 * 60 * 1000;
  state.verificationExpiryTimer = setTimeout(() => {
    const current = state.verification;
    if (!current || !['waiting', 'ready', 'starting', 'retrying'].includes(current.status)) return;
    bumpVerification();
    clearVerificationClock();
    stopVerificationPoll();
    dropVerificationSession(current);
    state.verification = nextVerification(current, {
      type: 'expired',
      couponId: current.couponId,
      accountEmail: current.accountEmail,
    });
    render();
  }, delay);
}

async function cancelVerification() {
  const current = state.verification;
  abortActiveVerificationRequest();
  bumpVerification();
  clearVerificationClock();
  state.verification = null;
  stopVerificationPoll();
  if (!current?.sessionId || !current.couponId) return;
  try {
    await api(`/api/coupons/${current.couponId}/verification/${current.sessionId}`, { method: 'DELETE', cache: 'no-store' });
  } catch {
    // The check already ended.
  }
}

function startVerificationPoll() {
  stopVerificationPoll();
  state.verificationTimer = setInterval(() => {
    pollVerification();
  }, 3000);
}

async function beginVerification(coupon) {
  if (!coupon?.cvsAccountEmail || coupon.otpReadable === false) return;
  if (state.verification?.couponId === coupon.id && state.verification.status === 'starting') return;
  const previous = state.verification?.couponId === coupon.id ? state.verification : null;
  if (state.verification && state.verification.couponId !== coupon.id) await cancelVerification();
  else abortActiveVerificationRequest();
  const generation = bumpVerification();
  const requestToken = verificationRequestToken;
  clearVerificationClock();
  stopVerificationPoll();
  state.verification = nextVerification(null, {
    type: 'starting',
    couponId: coupon.id,
    accountEmail: coupon.cvsAccountEmail,
  });
  state.error = '';
  state.notice = '';
  render();
  try {
    const opened = openVerificationRequest((signal) => api(`/api/coupons/${coupon.id}/verification`, { method: 'POST', cache: 'no-store', signal }));
    activeVerificationAbort = opened.abort;
    const data = await opened.request;
    if (requestToken !== verificationRequestToken || state.verificationGeneration !== generation || state.selectedId !== coupon.id) {
      if (data.sessionId) {
        await api(`/api/coupons/${coupon.id}/verification/${data.sessionId}`, { method: 'DELETE', cache: 'no-store' });
      }
      return;
    }
    state.verification = nextVerification(null, {
      type: 'waiting',
      couponId: coupon.id,
      accountEmail: data.accountEmail || coupon.cvsAccountEmail,
      sessionId: data.sessionId,
      expiresAt: data.expiresAt,
      startedAt: data.startedAt,
    });
    armVerificationExpiry(data.expiresAt);
    startVerificationPoll();
    pollVerification();
  } catch (error) {
    if (requestToken !== verificationRequestToken || state.verificationGeneration !== generation || state.selectedId !== coupon.id) return;
    if (error.name === 'AbortError') {
      const previousStillOpen = previous?.sessionId && Date.parse(previous.expiresAt || '') > Date.now();
      if (previousStillOpen) {
        state.verification = nextVerification(null, {
          type: previous.code ? 'ready' : 'waiting',
          couponId: coupon.id,
          accountEmail: previous.accountEmail,
          sessionId: previous.sessionId,
          expiresAt: previous.expiresAt,
          startedAt: previous.startedAt,
          code: previous.code,
          now: Date.now(),
        });
        armVerificationExpiry(previous.expiresAt);
        if (shouldPollVerification(state.verification.status)) startVerificationPoll();
      } else {
        state.verification = nextVerification(previous, {
          type: 'error',
          couponId: coupon.id,
          accountEmail: coupon.cvsAccountEmail,
          message: 'The mailbox check will try again. Press Start waiting again.',
        });
        clearVerificationClock();
        stopVerificationPoll();
      }
      render();
      return;
    }
    const previousStillOpen = previous?.sessionId && Date.parse(previous.expiresAt || '') > Date.now();
    if (previousStillOpen && /few seconds|Too many code checks/i.test(error.message)) {
      state.verification = nextVerification(null, {
        type: previous.code ? 'ready' : 'waiting',
        couponId: coupon.id,
        accountEmail: previous.accountEmail,
        sessionId: previous.sessionId,
        expiresAt: previous.expiresAt,
        code: previous.code,
        now: Date.now(),
      });
      state.verification = { ...state.verification, message: error.message };
      armVerificationExpiry(previous.expiresAt);
      startVerificationPoll();
    } else {
      dropVerificationSession(previous);
      state.verification = nextVerification(previous, {
        type: 'error',
        couponId: coupon.id,
        accountEmail: coupon.cvsAccountEmail,
        message: error.message,
      });
      clearVerificationClock();
      stopVerificationPoll();
    }
  }
  render();
}

function stillThisCheck(current, generation) {
  return state.verificationGeneration === generation && state.verification?.sessionId === current.sessionId;
}

async function pollVerification() {
  const current = state.verification;
  if (!current?.sessionId || current.status === 'starting' || state.verificationPolling) return;
  if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) {
    bumpVerification();
    clearVerificationClock();
    stopVerificationPoll();
    dropVerificationSession(current);
    state.verification = nextVerification(current, {
      type: 'expired',
      couponId: current.couponId,
      accountEmail: current.accountEmail,
    });
    render();
    return;
  }
  const generation = state.verificationGeneration;
  const requestToken = verificationRequestToken;
  const opened = openVerificationRequest((signal) => api(`/api/coupons/${current.couponId}/verification/${current.sessionId}`, { cache: 'no-store', signal }));
  activeVerificationAbort = opened.abort;
  state.verificationPolling = true;
  try {
    const data = await opened.request;
    if (requestToken !== verificationRequestToken || !stillThisCheck(current, generation)) return;
    if (data.status === 'waiting' || data.status === 'retrying') {
      const next = nextVerification(current, {
        type: data.status,
        couponId: current.couponId,
        accountEmail: current.accountEmail,
        sessionId: current.sessionId,
        expiresAt: data.expiresAt || current.expiresAt,
        startedAt: data.startedAt || current.startedAt,
        lastCheckedAt: data.lastCheckedAt || current.lastCheckedAt,
        message: data.message || '',
      });
      const changed = next.status !== state.verification.status || next.lastCheckedAt !== state.verification.lastCheckedAt;
      state.verification = next;
      armVerificationExpiry(next.expiresAt);
      if (changed) render();
      return;
    }
    if (data.status === 'ready' && data.code) {
      const next = nextVerification(current, {
        type: 'ready',
        couponId: current.couponId,
        accountEmail: current.accountEmail,
        sessionId: current.sessionId,
        expiresAt: data.expiresAt || current.expiresAt,
        startedAt: data.startedAt || current.startedAt,
        lastCheckedAt: data.lastCheckedAt || current.lastCheckedAt,
        code: data.code,
        now: Date.now(),
      });
      const changed = next.status !== state.verification.status || next.code !== state.verification.code;
      state.verification = next;
      if (next.status === 'ready') {
        armVerificationExpiry(next.expiresAt);
        stopVerificationPoll();
      }
      if (next.status !== 'ready') {
        clearVerificationClock();
        stopVerificationPoll();
        dropVerificationSession(current);
      }
      if (changed) render();
      return;
    }
    if (data.status === 'expired') {
      bumpVerification();
      clearVerificationClock();
      stopVerificationPoll();
      state.verification = nextVerification(current, {
        type: 'expired',
        couponId: current.couponId,
        accountEmail: current.accountEmail,
        message: data.error,
      });
      render();
      return;
    }
    if (data.status === 'error') {
      bumpVerification();
      clearVerificationClock();
      stopVerificationPoll();
      dropVerificationSession(current);
      state.verification = nextVerification(current, {
        type: 'error',
        couponId: current.couponId,
        accountEmail: current.accountEmail,
        message: data.error,
      });
      render();
    }
  } catch (error) {
    if (requestToken !== verificationRequestToken || !stillThisCheck(current, generation)) return;
    if (error.name === 'AbortError') {
      state.verification = nextVerification(current, {
        type: 'retrying',
        couponId: current.couponId,
        accountEmail: current.accountEmail,
        sessionId: current.sessionId,
        expiresAt: current.expiresAt,
        startedAt: current.startedAt,
        lastCheckedAt: current.lastCheckedAt,
        message: 'The mailbox check will try again. The email can take several minutes. You do not need to restart this wait.',
      });
      render();
      return;
    }
    if (error.message === 'Sign in required.') {
      bumpVerification();
      clearVerificationClock();
      state.verification = null;
      stopVerificationPoll();
      render();
      return;
    }
    const ended = /code check has ended|expired/i.test(error.message);
    const terminal = ended || /label was not found|signed in again|could not be checked/i.test(error.message);
    if (!terminal) {
      state.verification = nextVerification(current, {
        type: 'retrying',
        couponId: current.couponId,
        accountEmail: current.accountEmail,
        sessionId: current.sessionId,
        expiresAt: current.expiresAt,
        startedAt: current.startedAt,
        lastCheckedAt: current.lastCheckedAt,
        message: 'The mailbox check will try again. The email can take several minutes. You do not need to restart this wait.',
      });
      render();
      return;
    }
    bumpVerification();
    clearVerificationClock();
    stopVerificationPoll();
    state.verification = nextVerification(current, {
      type: ended ? 'ended' : 'error',
      couponId: current.couponId,
      accountEmail: current.accountEmail,
      message: error.message,
    });
    render();
  } finally {
    if (requestToken === verificationRequestToken) {
      state.verificationPolling = false;
      activeVerificationAbort = null;
    }
  }
}

function renderDetail(coupon) {
  const [kind, label] = badge(coupon);
  const note = barcodeNote(coupon);
  app.innerHTML = `
    <div class="detail">
      <button type="button" class="text-button" data-action="back">Back</button>
      <p class="eyebrow">${esc(label)}</p>
      <h1><span class="amount"><span>$</span>${coupon.amount}</span></h1>
      <p class="qualifier">${esc(termsText(coupon))}</p>
      <p class="sub">${esc(expiryText(coupon.expiresOn))}</p>
      <p class="meta-line">${coupon.cardLast4 ? `Card ••••${esc(coupon.cardLast4)}` : 'No card saved'}</p>
      <p class="meta-line">${coupon.subject ? esc(coupon.subject) : 'No subject saved'}${coupon.from ? ` · ${esc(coupon.from)}` : ''}</p>
      <div class="account-row">
        <p class="meta-line">${coupon.cvsAccountEmail ? esc(coupon.cvsAccountEmail) : 'No CVS account saved'}</p>
        ${coupon.cvsAccountEmail ? '<button type="button" class="secondary" data-action="copy-account">Copy account email</button>' : ''}
      </div>
      ${coupon.couponUrl ? `<a class="open-coupon" href="${esc(coupon.couponUrl)}" target="_blank" rel="noopener noreferrer">Open coupon</a>` : '<p class="help">This offer has no CVS link saved.</p>'}
      <p class="help">${esc(handoffText())}</p>
      ${state.notice ? `<p class="banner">${esc(state.notice)}</p>` : ''}
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}
      ${renderVerification(coupon)}
      ${note ? `<p class="help">${esc(note)}</p>` : ''}
      ${coupon.hasImage ? '<div class="scan-pad" id="scan-pad"><p class="help">Loading the saved image…</p></div>' : ''}
      ${coupon.captureError ? `<p class="error">${esc(coupon.captureError)}</p>` : ''}
      <form class="stack" data-action="attach-image">
        <label>Optional barcode image
          <input type="file" name="couponImage" accept="image/png,image/jpeg">
        </label>
        <button class="secondary" type="submit">Attach to this offer</button>
      </form>
      <div class="stack">
        ${coupon.imageKind === 'attached' ? '<button type="button" class="secondary" data-action="confirm-barcode">The saved image shows the barcode</button>' : ''}
        ${coupon.status === 'used'
          ? '<button type="button" class="secondary" data-action="restore">Mark available</button>'
          : `<button type="button" class="secondary" data-action="use">${state.confirmUse ? 'Confirm used' : 'Mark as used'}</button>`}
        <button type="button" class="text-button" data-action="remove">${state.confirmRemove ? 'Confirm remove' : 'Remove from this list'}</button>
      </div>
    </div>
  `;
  if (coupon.hasImage) loadImage(coupon);
  if (coupon.imageKind === 'code' && coupon.status !== 'used') {
    navigator.wakeLock?.request('screen').catch(() => {});
  }
}

function renderAdd() {
  return `
    <form class="stack" data-action="save-add">
      <div class="amount-pick">
        <button class="chip" type="button" data-action="draft-amount" data-amount="2" aria-pressed="${state.draftAmount === 2}">$2</button>
        <button class="chip" type="button" data-action="draft-amount" data-amount="4" aria-pressed="${state.draftAmount === 4}">$4</button>
      </div>
      <label>Expires
        <input type="date" name="expires" value="${esc(state.draftDate)}">
      </label>
      <label>Coupon screen
        <input type="file" name="image" accept="image/*">
      </label>
      <button class="primary" type="submit">Save coupon</button>
    </form>
  `;
}

async function loadImage(coupon) {
  const pad = document.getElementById('scan-pad');
  if (!pad || state.selectedId !== coupon.id) return;
  try {
    const response = await fetch(`/api/coupons/${coupon.id}/image`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) throw new Error('missing');
    const blob = await response.blob();
    await idbSet(`img:${coupon.id}`, blob);
    showBlob(pad, blob, coupon);
  } catch {
    const cached = await idbGet(`img:${coupon.id}`);
    if (cached) showBlob(pad, cached, coupon);
    else pad.innerHTML = '<p class="help">The screen is not on this phone yet.</p>';
  }
}

function showBlob(pad, blob, coupon) {
  const url = URL.createObjectURL(blob);
  const alt = coupon?.imageKind === 'code' ? 'Coupon barcode' : 'Image attached — verify barcode';
  pad.innerHTML = `<img alt="${esc(alt)}" src="${url}">`;
}

async function refresh({ quiet = false } = {}) {
  try {
    const data = await api('/api/coupons');
    state.coupons = (data.coupons || []).map((coupon) => {
      const copy = { ...coupon };
      delete copy.code;
      delete copy.verificationCode;
      return copy;
    });
    state.info = { ...(state.info || {}), lastScan: data.sync?.lastSuccess || data.lastScan, sync: data.sync || state.info?.sync || null };
    state.offline = false;
    state.unlocked = true;
    await idbSet('coupons', data.coupons);
    await idbSet('lastScan', state.info.lastScan || '');
  } catch (error) {
    const cached = await idbGet('coupons');
    if (cached && error.message !== 'Sign in required.') {
      state.coupons = cached;
      state.info = { ...(state.info || {}), lastScan: await idbGet('lastScan') };
      state.offline = true;
      state.unlocked = true;
    } else if (error.message !== 'Sign in required.') {
      state.error = error.message;
    }
  }
  if (!quiet || !state.selectedId) render();
}

async function flushOutbox() {
  const outbox = (await idbGet('outbox')) || [];
  if (!outbox.length) return;
  const left = [];
  for (const item of outbox) {
    try {
      await api(`/api/coupons/${item.id}/${item.op}`, { method: 'POST' });
    } catch {
      left.push(item);
    }
  }
  await idbSet('outbox', left);
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.tagName === 'FORM') return;
  const action = button.dataset.action;
  if (action === 'filter') {
    state.filter = button.dataset.filter;
    render();
  } else if (action === 'open') {
    if (state.verification && state.verification.couponId !== button.dataset.id) await cancelVerification();
    state.selectedId = button.dataset.id;
    state.confirmUse = false;
    state.confirmRemove = false;
    state.notice = '';
    state.error = '';
    render();
  } else if (action === 'back') {
    await cancelVerification();
    state.selectedId = null;
    state.notice = '';
    render();
  } else if (action === 'add') {
    state.adding = !state.adding;
    render();
  } else if (action === 'draft-amount') {
    state.draftAmount = Number(button.dataset.amount);
    render();
  } else if (action === 'use') {
    if (!state.confirmUse) {
      state.confirmUse = true;
      render();
      return;
    }
    await changeStatus('use', 'used');
  } else if (action === 'restore') {
    await changeStatus('restore', 'available');
  } else if (action === 'remove') {
    if (!state.confirmRemove) {
      state.confirmRemove = true;
      render();
      return;
    }
    const id = state.selectedId;
    await cancelVerification();
    try {
      await api(`/api/coupons/${id}`, { method: 'DELETE' });
    } catch (error) {
      state.error = error.message;
    }
    state.coupons = state.coupons.filter((coupon) => coupon.id !== id);
    state.selectedId = null;
    await idbSet('coupons', state.coupons);
    render();
  } else if (action === 'confirm-barcode') {
    const id = state.selectedId;
    const coupon = state.coupons.find((item) => item.id === id);
    if (!coupon) return;
    state.error = '';
    try {
      const data = await api(`/api/coupons/${id}/image`, {
        method: 'POST',
        body: JSON.stringify({ confirmBarcode: true }),
      });
      Object.assign(coupon, data.coupon);
      await idbSet('coupons', state.coupons);
    } catch (error) {
      state.error = error.message;
    }
    render();
  } else if (action === 'verify-start') {
    const coupon = state.coupons.find((item) => item.id === state.selectedId);
    if (!coupon) return;
    await beginVerification(coupon);
  } else if (action === 'verify-cancel') {
    await cancelVerification();
    state.notice = '';
    render();
  } else if (action === 'copy-code') {
    const next = nextVerification(state.verification, { type: 'copy', now: Date.now() });
    state.verification = next;
    const code = next?.status === 'ready' ? next.code : '';
    if (!code) {
      clearVerificationClock();
      stopVerificationPoll();
      state.error = 'That code check expired. Start waiting again, then click Send code.';
      render();
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      state.notice = 'Code copied.';
      state.error = '';
    } catch {
      state.error = 'The code could not be copied. Select it on this screen.';
    }
    render();
  } else if (action === 'copy-account') {
    const coupon = state.coupons.find((item) => item.id === state.selectedId);
    if (!coupon?.cvsAccountEmail) return;
    try {
      await navigator.clipboard.writeText(coupon.cvsAccountEmail);
      state.notice = 'Account email copied.';
      state.error = '';
    } catch {
      state.error = 'The email could not be copied. Select it from the screen.';
    }
    render();
  } else if (action === 'scan') {
    state.scanning = true;
    state.error = '';
    state.notice = '';
    render();
    try {
      const result = await api('/api/scan', { method: 'POST' });
      state.notice = result.skipped === 'overlap'
        ? 'A mailbox check is already running.'
        : `Found ${result.found}. Added ${result.imported}. Already in the list: ${result.already}.`;
      state.scanning = false;
      await refresh();
    } catch (error) {
      state.error = error.message;
      state.scanning = false;
      render();
    }
  }
});

app.addEventListener('change', async (event) => {
  const input = event.target;
  if (input?.name !== 'image' || !input.files?.[0]) return;
  const file = input.files[0];
  state.draftImage = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
});

app.addEventListener('submit', async (event) => {
  const form = event.target.closest('form');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.action === 'unlock') {
    state.token = new FormData(form).get('token').trim();
    state.error = '';
    try {
      await api('/api/session', { method: 'POST' });
      localStorage.setItem(TOKEN_KEY, state.token);
      state.unlocked = true;
      await refresh();
      flushOutbox();
    } catch (error) {
      state.error = error.message === 'Sign in required.' ? 'That token was not accepted.' : error.message;
      state.token = '';
      render();
    }
    return;
  }
  if (form.dataset.action === 'attach-image') {
    const coupon = state.coupons.find((item) => item.id === state.selectedId);
    const file = form.querySelector('input[name="couponImage"]')?.files?.[0];
    if (!coupon) return;
    if (!file || (file.type !== 'image/png' && file.type !== 'image/jpeg')) {
      state.error = 'Use a PNG or JPEG from the print preview.';
      render();
      return;
    }
    const imageData = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
    try {
      const data = await api(`/api/coupons/${coupon.id}/image`, {
        method: 'POST',
        body: JSON.stringify({ imageData }),
      });
      Object.assign(coupon, data.coupon);
      state.error = '';
      state.notice = 'Image attached — verify barcode.';
      await idbSet('coupons', state.coupons);
    } catch (error) {
      state.error = error.message;
    }
    render();
    return;
  }
  if (form.dataset.action === 'save-add') {
    try {
      const date = new FormData(form).get('expires');
      const data = await api('/api/coupons', {
        method: 'POST',
        body: JSON.stringify({
          amount: state.draftAmount,
          expiresOn: date || null,
          imageData: state.draftImage || null,
        }),
      });
      state.coupons.push(data.coupon);
      state.adding = false;
      state.draftImage = '';
      state.selectedId = data.coupon.id;
      await idbSet('coupons', state.coupons);
      render();
    } catch (error) {
      state.error = error.message;
      render();
    }
  }
});

async function changeStatus(op, status) {
  const id = state.selectedId;
  const coupon = state.coupons.find((item) => item.id === id);
  if (!coupon) return;
  try {
    const data = await api(`/api/coupons/${id}/${op}`, { method: 'POST' });
    Object.assign(coupon, data.coupon);
    state.offline = false;
  } catch (error) {
    if (error.message === 'Sign in required.') {
      render();
      return;
    }
    coupon.status = status;
    const outbox = (await idbGet('outbox')) || [];
    outbox.push({ id, op });
    await idbSet('outbox', outbox);
    state.notice = 'Saved on this phone. It will sync when the server is back.';
  }
  state.confirmUse = false;
  await idbSet('coupons', state.coupons);
  render();
}

async function boot() {
  const cached = await idbGet('coupons');
  if (cached) state.coupons = cached;
  if (!state.token) {
    render();
    return;
  }
  try {
    await api('/api/session', { method: 'POST' });
    state.unlocked = true;
    state.info = await api('/api/info');
    await refresh();
    flushOutbox();
    if (!state.refreshTimer) {
      state.refreshTimer = setInterval(() => {
        if (!state.unlocked || state.selectedId || state.scanning) return;
        refresh({ quiet: true });
      }, 15000);
    }
  } catch (error) {
    if (cached && error.message !== 'Sign in required.') {
      state.unlocked = true;
      state.offline = true;
      render();
      return;
    }
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    state.error = error.message === 'Sign in required.' ? '' : error.message;
    render();
  }
}

function resumeVerification() {
  const current = state.verification;
  if (!current?.sessionId || current.status === 'starting') return;
  const next = nextVerification(current, { type: 'resume', now: Date.now() });
  state.verification = next;
  if (!next?.sessionId) {
    clearVerificationClock();
    stopVerificationPoll();
    dropVerificationSession(current);
    render();
    return;
  }
  if (!shouldPollVerification(next.status)) {
    stopVerificationPoll();
    if (next.status === 'ready') armVerificationExpiry(next.expiresAt);
    render();
    return;
  }
  if (!state.verificationTimer) startVerificationPoll();
  pollVerification();
}

function recoverVerification() {
  const current = state.verification;
  if (!current?.sessionId || current.status === 'starting') return;
  if (shouldPollVerification(current.status) && state.verificationPolling) abortActiveVerificationRequest();
  resumeVerification();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recoverVerification();
});
window.addEventListener('pageshow', () => recoverVerification());
window.addEventListener('online', () => recoverVerification());

window.addEventListener('pagehide', () => {
  const current = state.verification;
  abortActiveVerificationRequest();
  bumpVerification();
  clearVerificationClock();
  stopVerificationPoll();
  state.verification = null;
  if (!current?.sessionId || !current.couponId) return;
  fetch(`/api/coupons/${current.couponId}/verification/${current.sessionId}`, {
    method: 'DELETE',
    keepalive: true,
    cache: 'no-store',
    headers: { authorization: `Bearer ${state.token}` },
  }).catch(() => {});
});

boot();
