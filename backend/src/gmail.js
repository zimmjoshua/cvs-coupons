import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { simpleParser } from 'mailparser';
import { parseCouponEmail } from './parseCoupon.js';
import { htmlAsText, resolveCvsAccount, selectMatchingCode } from './accountIdentity.js';
import { getMeta, setMeta } from './couponStore.js';
import { couponHistoryParams, couponListParams, findLabel, GMAIL_SCOPE, labelName, missingLabelError } from './gmailQuery.js';
import { collectLabelVerification, matchLabelVerification, previewFromMetadata, runLabelVerificationRead, shouldFetchVerificationBody, throwIfAborted, VERIFICATION_METADATA_HEADERS } from './verificationMail.js';
import { collectMessageIds, isReauthError, runMailboxSync, shouldOpenOAuth } from './syncOffers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tokenFile = path.join(here, '../data/google-token.json');
const redirectUri = 'http://127.0.0.1:53682/oauth2callback';
let memoryToken = null;

function clientConfig() {
  return {
    id: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    secret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  };
}

function missingClientError() {
  return new Error(
    'Gmail sign-in is not set up. In Google Cloud, create an OAuth desktop client and put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env. Use redirect URI http://127.0.0.1:53682/oauth2callback.',
  );
}

function tokenRecord(token) {
  if (!token?.refresh_token) return null;
  return {
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expiry: token.expiry,
  };
}

async function loadToken() {
  if (memoryToken?.refresh_token) return memoryToken;
  try {
    const raw = await getMeta('gmail_token');
    const parsed = raw ? tokenRecord(JSON.parse(raw)) : null;
    if (parsed) {
      memoryToken = parsed;
      return memoryToken;
    }
  } catch {
    // The local token file and env secret still work when Postgres is down.
  }
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    memoryToken = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN.trim() };
    return memoryToken;
  }
  if (!fs.existsSync(tokenFile)) return null;
  try {
    memoryToken = tokenRecord(JSON.parse(fs.readFileSync(tokenFile, 'utf8')));
    return memoryToken;
  } catch {
    return null;
  }
}

async function saveToken(token) {
  memoryToken = tokenRecord(token);
  if (!memoryToken) return;
  try {
    await setMeta('gmail_token', JSON.stringify(memoryToken));
  } catch {
    // A hosted disk may be ephemeral. The env secret remains the source until Postgres accepts the row.
  }
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify(memoryToken, null, 2), { mode: 0o600 });
  } catch {
    // Render's filesystem is ephemeral. Postgres and GOOGLE_REFRESH_TOKEN keep the login.
  }
}

function requestSignal(signal, ms = 15000) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

async function tokenRequest(body, { signal } = {}) {
  throwIfAborted(signal);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: requestSignal(signal),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(`Gmail could not be signed in. ${data.error_description || data.error || 'Google did not return a token.'}`);
    error.oauthError = data.error || '';
    throw error;
  }
  return data;
}

function openBrowser(url) {
  execFile('open', [url], (error) => {
    if (error) console.error('Open this URL to sign in:', url);
  });
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url || '/', redirectUri);
      if (url.pathname !== '/oauth2callback') {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const oauthError = url.searchParams.get('error');
      if (oauthError) {
        response.end('<p>Google did not allow mailbox access. You can close this window.</p>');
      } else {
        response.end('<p>Gmail is connected. You can close this window and return to Coupons.</p>');
      }
      server.close();
      if (oauthError) reject(new Error('Gmail sign-in was cancelled.'));
      else resolve(url.searchParams.get('code'));
    });
    server.on('error', reject);
    server.listen(53682, '127.0.0.1');
  });
}

async function signIn() {
  const client = clientConfig();
  if (!client.id || !client.secret) throw missingClientError();
  const loginHint = (process.env.GMAIL_USER || '').trim();
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', client.id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GMAIL_SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  if (loginHint) authUrl.searchParams.set('login_hint', loginHint);

  const codePromise = waitForCode();
  openBrowser(authUrl.toString());
  let timer;
  const code = await Promise.race([
    codePromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Gmail sign-in timed out. Run the scan again and finish the Google prompt.')), 180000);
    }),
  ]).finally(() => clearTimeout(timer));
  const issued = await tokenRequest({
    code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const token = {
    refresh_token: issued.refresh_token,
    access_token: issued.access_token,
    expiry: Date.now() + Number(issued.expires_in || 3600) * 1000,
  };
  if (!token.refresh_token) {
    throw new Error('Gmail did not return a saved login. Remove Coupons under Google Account permissions and scan again.');
  }
  await saveToken(token);
  return token.access_token;
}

function reauthError() {
  const error = new Error('Gmail needs to be signed in again. A Testing-mode refresh token can expire after 7 days. Background checks will not open a Google prompt.');
  error.oauthError = 'invalid_grant';
  return error;
}

async function accessToken({ interactive = false, signal } = {}) {
  throwIfAborted(signal);
  const client = clientConfig();
  const saved = await loadToken();
  if (saved?.access_token && saved.expiry && saved.expiry > Date.now() + 30000) return saved.access_token;
  if (!saved?.refresh_token) {
    if (!shouldOpenOAuth({ interactive, oauthError: 'missing_refresh_token' })) throw reauthError();
    return signIn();
  }
  if (!client.id || !client.secret) throw missingClientError();
  try {
    const issued = await tokenRequest({
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: saved.refresh_token,
      grant_type: 'refresh_token',
    }, { signal });
    const token = {
      refresh_token: saved.refresh_token,
      access_token: issued.access_token,
      expiry: Date.now() + Number(issued.expires_in || 3600) * 1000,
    };
    await saveToken(token);
    return token.access_token;
  } catch (error) {
    if (!isReauthError(error)) throw error;
    if (!shouldOpenOAuth({ interactive, oauthError: 'invalid_grant' })) throw reauthError();
    return signIn();
  }
}

function retryAfterMs(header) {
  const value = String(header || '').trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return 0;
  return Math.max(0, date - Date.now());
}

async function gmail(pathname, token, params, signal) {
  throwIfAborted(signal);
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${pathname}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else if (value != null && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: requestSignal(signal),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Gmail could not be read.');
    error.status = response.status;
    error.oauthError = data.error?.status || '';
    error.reasons = (data.error?.errors || []).map((item) => item?.reason).filter(Boolean);
    error.reason = error.reasons[0] || '';
    error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'));
    throw error;
  }
  return data;
}

function isCvsSender(address) {
  const domain = String(address || '').toLowerCase().split('@')[1] || '';
  return domain === 'cvs.com' || domain.endsWith('.cvs.com');
}

function isCouponMail(parsed) {
  const from = parsed.from?.value?.[0]?.address || '';
  const subject = parsed.subject || '';
  const body = `${subject}\n${parsed.text || ''}\n${parsed.html || ''}`;
  if (isCvsSender(from)) return true;
  if (/\$[24](?!\d)\s*coupon/i.test(subject)) return true;
  return /@([a-z0-9-]+\.)*cvs\.com/i.test(body);
}

function headerBag(parsed) {
  return {
    to: parsed.headers?.get('to'),
    deliveredTo: parsed.headers?.get('delivered-to'),
    xOriginalTo: parsed.headers?.get('x-original-to'),
    xGmOriginalTo: parsed.headers?.get('x-gm-original-to'),
    envelopeTo: parsed.headers?.get('envelope-to'),
  };
}

function verificationCode(text) {
  const labeled = String(text || '').match(/verification code[\s\S]{0,80}?(\d{6})/i);
  if (labeled) return labeled[1];
  const standalone = String(text || '').match(/\b(\d{6})\b/);
  return standalone ? standalone[1] : null;
}

export async function waitForVerificationCode(afterMs, expectedRecipient, { shouldStop, mailbox } = {}) {
  const expected = String(expectedRecipient || '').trim().toLowerCase();
  if (!expected || !Number.isFinite(Number(afterMs))) return null;
  const token = await accessToken();
  const connected = String(mailbox || process.env.GMAIL_USER || '').trim().toLowerCase();
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (shouldStop?.()) return null;
    const listed = await gmail('messages', token, {
      q: 'from:info@alerts.cvs.com subject:"verification code" newer_than:1d',
      maxResults: '10',
    });
    const candidates = [];
    for (const item of listed.messages || []) {
      if (shouldStop?.()) return null;
      const message = await gmail(`messages/${item.id}`, token, { format: 'raw' });
      const raw = Buffer.from(String(message.raw || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const parsed = await simpleParser(raw);
      candidates.push({
        from: parsed.from?.value?.[0]?.address || '',
        headers: headerBag(parsed),
        internalDate: Number(message.internalDate || 0),
        code: verificationCode(`${parsed.subject || ''}\n${parsed.text || ''}\n${parsed.html || ''}`),
      });
    }
    const code = selectMatchingCode(candidates, { expectedRecipient: expected, afterMs, mailbox: connected });
    if (code) return code;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  return null;
}

export function gmailConfigured() {
  const client = clientConfig();
  return Boolean((client.id && client.secret) || process.env.GOOGLE_REFRESH_TOKEN || fs.existsSync(tokenFile));
}

let connectedMailbox = '';
let resolvedLabel = null;

async function resolveCvsLabel(token, signal) {
  throwIfAborted(signal);
  const name = labelName();
  if (resolvedLabel?.name === name && resolvedLabel.id) return resolvedLabel;
  const data = await gmail('labels', token, undefined, signal);
  const match = findLabel(data.labels, name);
  if (!match?.id) throw missingLabelError(name);
  resolvedLabel = { id: match.id, name };
  return resolvedLabel;
}

export async function cvsLabelStatus() {
  const token = await accessToken({ interactive: false });
  try {
    const label = await resolveCvsLabel(token);
    return { found: true, name: label.name, id: label.id };
  } catch (error) {
    if (error.code === 'label_missing') return { found: false, name: error.labelName || labelName(), id: null };
    throw error;
  }
}

async function requireMailbox(token, signal) {
  throwIfAborted(signal);
  const profile = await gmail('profile', token, undefined, signal);
  const expected = (process.env.GMAIL_USER || '').trim().toLowerCase();
  const actual = String(profile.emailAddress || '').toLowerCase();
  if (expected && actual && expected !== actual) {
    throw new Error(`Gmail signed in as ${actual}. Scan expects ${expected}.`);
  }
  connectedMailbox = actual;
  return profile;
}

async function listCouponPage({ pageToken, maxResults }, interactive) {
  const token = await accessToken({ interactive });
  const label = await resolveCvsLabel(token);
  let historyId = null;
  if (!pageToken) {
    const profile = await requireMailbox(token);
    historyId = profile.historyId ? String(profile.historyId) : null;
  }
  const listed = await gmail('messages', token, couponListParams({
    labelId: label.id,
    pageToken,
    maxResults,
    label: label.name,
  }));
  return {
    messages: listed.messages || [],
    nextPageToken: listed.nextPageToken || '',
    historyId,
    labelId: label.id,
  };
}

async function historyCouponPage({ startHistoryId, pageToken, maxResults }, interactive) {
  const token = await accessToken({ interactive });
  const label = await resolveCvsLabel(token);
  const page = await gmail('history', token, couponHistoryParams({
    labelId: label.id,
    startHistoryId,
    pageToken,
    maxResults,
    label: label.name,
  }));
  return {
    history: page.history || [],
    nextPageToken: page.nextPageToken || '',
    historyId: page.historyId ? String(page.historyId) : null,
    labelId: label.id,
  };
}

export async function rereadCouponMessages(ids) {
  const offers = [];
  for (const id of ids || []) offers.push(...await offersFromMessage(id, false));
  return offers;
}

async function offersFromMessage(id, interactive) {
  const token = await accessToken({ interactive });
  if (!connectedMailbox) await requireMailbox(token);
  let message;
  try {
    message = await gmail(`messages/${id}`, token, { format: 'raw' });
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
  const raw = Buffer.from(String(message.raw || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const parsed = await simpleParser(raw);
  if (!isCouponMail(parsed)) return [];
  const from = parsed.from?.value?.[0]?.address || '';
  const found = parseCouponEmail({
    subject: parsed.subject || '',
    html: parsed.html || '',
    text: parsed.text || '',
    messageId: parsed.messageId || message.id,
    from,
    date: parsed.date || null,
  });
  const account = resolveCvsAccount({
    subject: parsed.subject || '',
    html: parsed.html || '',
    text: parsed.text || '',
    headers: headerBag(parsed),
    mailbox: connectedMailbox,
  });
  for (const offer of found) {
    offer.cvsAccountEmail = account.cvsAccountEmail;
    offer.forwarded = account.forwarded;
    offer.mailbox = account.mailbox;
    offer.otpReadable = account.otpReadable;
    if (account.cardLast4) offer.cardLast4 = account.cardLast4;
  }
  return found;
}

export async function findCouponEmails({ interactive = false } = {}) {
  const pageSize = Math.max(1, Number(process.env.SCAN_LIMIT || 5));
  const collected = await collectMessageIds({
    pageSize,
    listPage: (page) => listCouponPage(page, interactive),
    historyPage: null,
    checkpoint: {},
  });
  const offers = [];
  for (const id of collected.ids) offers.push(...await offersFromMessage(id, interactive));
  return offers;
}

async function parseVerificationMessage(message) {
  const raw = Buffer.from(String(message.raw || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const parsed = await simpleParser(raw);
  return {
    from: parsed.from?.value?.[0]?.address || '',
    subject: parsed.subject || '',
    text: `${parsed.text || ''}\n${htmlAsText(parsed.html || '')}`,
    headers: headerBag(parsed),
  };
}

export async function readLabelVerificationCode({ expectedRecipient, afterMs, skipIds, pageToken, signal } = {}) {
  const expected = String(expectedRecipient || '').trim().toLowerCase();
  if (!expected || !Number.isFinite(Number(afterMs))) return null;
  return runLabelVerificationRead({
    signal,
    prepare: async (current) => {
      const token = await accessToken({ interactive: false, signal: current });
      const label = await resolveCvsLabel(token, current);
      if (!connectedMailbox) await requireMailbox(token, current);
      return { token, label };
    },
    collect: async ({ token, label }, current) => {
      const collected = await collectLabelVerification({
        signal: current,
        labelId: label.id,
        afterMs,
        pageToken,
        expectedRecipient: expected,
        mailbox: connectedMailbox,
        skipIds: new Set(skipIds || []),
        list: (params) => gmail('messages', token, params, current),
        getMessage: async (id) => {
          throwIfAborted(current);
          const meta = await gmail(`messages/${id}`, token, {
            format: 'metadata',
            metadataHeaders: VERIFICATION_METADATA_HEADERS,
          }, current);
          const preview = previewFromMetadata(meta);
          if (!preview.labelIds.length) preview.labelIds = [label.id];
          const pass = shouldFetchVerificationBody({
            ...preview,
            labelId: label.id,
            afterMs,
            expectedRecipient: expected,
            mailbox: connectedMailbox,
          });
          if (!pass) return { id, internalDate: preview.internalDate, labelIds: preview.labelIds.length ? preview.labelIds : [label.id], preview };
          throwIfAborted(current);
          const full = await gmail(`messages/${id}`, token, { format: 'raw' }, current);
          return {
            ...full,
            labelIds: Array.isArray(full.labelIds) && full.labelIds.length ? full.labelIds : preview.labelIds,
            internalDate: full.internalDate || preview.internalDate,
          };
        },
        parseMessage: parseVerificationMessage,
      });
      const { messages, bodyIds } = collected;
      const code = matchLabelVerification(messages, {
        expectedRecipient: expected,
        afterMs,
        mailbox: connectedMailbox,
        labelId: label.id,
      });
      const matched = messages.find((message) => message.internalDate >= afterMs);
      return {
        code: code || '',
        skippedIds: bodyIds,
        complete: collected.complete,
        pageToken: collected.pageToken,
        delivery: code && matched ? { receivedAt: new Date(matched.internalDate).toISOString() } : null,
      };
    },
  });
}

export async function syncConnectedMailbox(state, { interactive = false, intervalMs = 60000, upsert } = {}) {
  const pageSize = Math.max(1, Number(process.env.SCAN_LIMIT || 5));
  return runMailboxSync({
    now: new Date().toISOString(),
    state,
    intervalMs,
    pageSize,
    listPage: (page) => listCouponPage(page, interactive),
    historyPage: (page) => historyCouponPage(page, interactive),
    readOffers: (id) => offersFromMessage(id, interactive),
    upsert,
  });
}
