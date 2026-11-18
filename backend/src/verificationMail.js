import { envelopeRecipient, selectMatchingCode, VERIFICATION_SENDER } from './accountIdentity.js';
import { verificationListParams } from './gmailQuery.js';

export const VERIFICATION_MAX_PAGES = 8;
export const VERIFICATION_METADATA_HEADERS = [
  'From',
  'Subject',
  'To',
  'Delivered-To',
  'X-Original-To',
  'X-Gm-Original-To',
  'Envelope-To',
];

export function previewFromMetadata(message) {
  const headers = {};
  for (const header of message?.payload?.headers || []) {
    const name = String(header?.name || '').toLowerCase();
    if (name === 'from') headers.from = header.value;
    if (name === 'to') headers.to = header.value;
    if (name === 'subject') headers.subject = header.value;
    if (name === 'delivered-to') headers.deliveredTo = header.value;
    if (name === 'x-original-to') headers.xOriginalTo = header.value;
    if (name === 'x-gm-original-to') headers.xGmOriginalTo = header.value;
    if (name === 'envelope-to') headers.envelopeTo = header.value;
  }
  const from = String(headers.from || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || '';
  return {
    from,
    subject: headers.subject || '',
    headers,
    internalDate: Number(message?.internalDate || 0),
    labelIds: Array.isArray(message?.labelIds) ? message.labelIds : [],
  };
}

export function isVerificationMessage({ from, subject = '', text = '' } = {}) {
  if (String(from || '').trim().toLowerCase() !== VERIFICATION_SENDER) return false;
  return /verification code/i.test(`${subject}\n${text}`);
}

export function extractVerificationCode(text) {
  const match = String(text || '').match(/verification code[\s\S]{0,120}?(\d{6})/i);
  return match ? match[1] : null;
}

export function matchLabelVerification(messages, { expectedRecipient, afterMs, mailbox, labelId } = {}) {
  const candidates = [];
  for (const message of messages || []) {
    const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
    if (!labelId || !labels.includes(labelId)) continue;
    const from = message.from || '';
    const subject = message.subject || '';
    const text = message.text || '';
    if (!isVerificationMessage({ from, subject, text })) continue;
    const code = extractVerificationCode(`${subject}\n${text}`);
    if (!code) continue;
    candidates.push({
      from,
      recipient: message.recipient,
      headers: message.headers,
      internalDate: message.internalDate,
      code,
    });
  }
  return selectMatchingCode(candidates, { expectedRecipient, afterMs, mailbox, lookbackMs: 0 });
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('The mailbox check timed out.');
  error.name = 'AbortError';
  throw error;
}

export async function runLabelVerificationRead({ signal, prepare, collect }) {
  throwIfAborted(signal);
  const prepared = await prepare(signal);
  throwIfAborted(signal);
  return collect(prepared, signal);
}

export function shouldFetchVerificationBody({
  from,
  subject = '',
  internalDate,
  labelIds,
  labelId,
  afterMs,
  expectedRecipient,
  mailbox,
  headers,
} = {}) {
  const labels = Array.isArray(labelIds) ? labelIds : [];
  if (!labelId || !labels.includes(labelId)) return false;
  if (String(from || '').trim().toLowerCase() !== VERIFICATION_SENDER) return false;
  if (!/verification code/i.test(String(subject || ''))) return false;
  const sent = Number(internalDate);
  const start = Number(afterMs);
  if (!Number.isFinite(sent) || !Number.isFinite(start) || sent < start) return false;
  if (expectedRecipient) {
    const recipient = envelopeRecipient(headers || {}, mailbox);
    if (recipient !== String(expectedRecipient).trim().toLowerCase()) return false;
  }
  return true;
}

export async function collectLabelVerification({
  labelId,
  list,
  getMessage,
  parseMessage,
  afterMs = 0,
  maxResults = 15,
  maxPages = VERIFICATION_MAX_PAGES,
  expectedRecipient,
  mailbox,
  skipIds,
  pageToken: startToken = '',
  signal,
} = {}) {
  const params = verificationListParams({ labelId, maxResults, afterMs });
  const messages = [];
  const bodyIds = [];
  const seen = skipIds instanceof Set ? skipIds : new Set(skipIds || []);
  let pageToken = startToken || '';
  let pages = 0;
  while (pages < maxPages) {
    throwIfAborted(signal);
    const listed = await list(verificationListParams({ labelId, maxResults, afterMs, pageToken }));
    throwIfAborted(signal);
    pages += 1;
    const batch = listed?.messages || [];
    if (!batch.length) {
      pageToken = listed?.nextPageToken || '';
      if (!pageToken) break;
      continue;
    }
    for (const item of batch) {
      throwIfAborted(signal);
      if (!item?.id || seen.has(item.id)) continue;
      const message = await getMessage(item.id);
      throwIfAborted(signal);
      const explicit = Array.isArray(message?.labelIds) ? message.labelIds : null;
      const labelIds = explicit && explicit.length ? explicit : [labelId];
      const sent = Number(message?.internalDate || message?.preview?.internalDate || 0);
      const preview = message?.preview;
      if (preview && !shouldFetchVerificationBody({
        ...preview,
        labelIds: preview.labelIds?.length ? preview.labelIds : labelIds,
        labelId,
        afterMs,
        expectedRecipient,
        mailbox,
      })) {
        continue;
      }
      const parsed = await parseMessage(message);
      bodyIds.push(item.id);
      messages.push({
        id: item.id,
        labelIds,
        from: parsed?.from || '',
        subject: parsed?.subject || '',
        text: parsed?.text || '',
        headers: parsed?.headers || {},
        recipient: parsed?.recipient,
        internalDate: sent || Number(parsed?.internalDate || 0),
      });
    }
    pageToken = listed?.nextPageToken || '';
    if (!pageToken) break;
  }
  return { params, messages, pages, bodyIds, complete: !pageToken, pageToken: pageToken || '' };
}
