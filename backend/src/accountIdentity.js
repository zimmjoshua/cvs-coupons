const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const VERIFICATION_SENDER = 'info@alerts.cvs.com';
export const VERIFICATION_LOOKBACK_MS = 15000;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function addressesIn(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  const found = [];
  for (const item of items) {
    if (item && Array.isArray(item.value)) {
      for (const entry of item.value) {
        if (entry?.address) found.push(String(entry.address).toLowerCase());
      }
    }
    const text = typeof item === 'string' ? item : item?.text || '';
    if (text) found.push(...[...String(text).matchAll(EMAIL_RE)].map((match) => match[0].toLowerCase()));
  }
  return unique(found);
}

export function isCvsAddress(address) {
  const domain = String(address || '').toLowerCase().split('@')[1] || '';
  return domain === 'cvs.com' || domain.endsWith('.cvs.com');
}

export function mailboxDomain(mailbox) {
  return String(mailbox || '').trim().toLowerCase().split('@')[1] || '';
}

export function otpReadableInMailbox(accountEmail, mailbox) {
  const account = String(accountEmail || '').trim().toLowerCase();
  const domain = mailboxDomain(mailbox);
  const accountDomain = account.split('@')[1] || '';
  return Boolean(account && domain && accountDomain === domain);
}

export function htmlAsText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*64;/g, '@')
    .replace(/&nbsp;/gi, ' ');
}

export function isForwardedMessage({ subject = '', html = '', text = '' }) {
  if (/^\s*(fw|fwd)\s*:/i.test(subject)) return true;
  const body = `${htmlAsText(html)}\n${text || ''}`;
  return /begin forwarded message|^\s*-{5,}\s*forwarded message/im.test(body);
}

export function forwardedOriginalRecipient({ subject = '', html = '', text = '' }) {
  if (!isForwardedMessage({ subject, html, text })) return null;
  const body = `${htmlAsText(html)}\n${text || ''}`;
  const start = body.search(/begin forwarded message|^\s*-{5,}\s*forwarded message/im);
  const block = start >= 0 ? body.slice(start, start + 4000) : body.slice(0, 4000);
  for (const line of block.split('\n')) {
    const match = line.replace(/\s+/g, ' ').trim().match(/^To:\s*(.+)$/i);
    if (!match) continue;
    const recipient = [...match[1].matchAll(EMAIL_RE)]
      .map((item) => item[0].toLowerCase())
      .find((address) => !isCvsAddress(address));
    if (recipient) return recipient;
  }
  return null;
}

function pickRecipient(addresses, mailbox) {
  const cleaned = unique(addresses.map((address) => String(address || '').toLowerCase()).filter((address) => !isCvsAddress(address)));
  if (!cleaned.length) return null;
  const box = String(mailbox || '').trim().toLowerCase();
  const domain = mailboxDomain(box);
  if (domain) {
    const alias = cleaned.find((address) => address.endsWith(`@${domain}`) && address !== box);
    if (alias) return alias;
  }
  return cleaned[0];
}

export function envelopeRecipient(headers = {}, mailbox = '') {
  const original = [
    ...addressesIn(headers.xGmOriginalTo),
    ...addressesIn(headers.xOriginalTo),
    ...addressesIn(headers.envelopeTo),
  ];
  const fromOriginal = pickRecipient(original, mailbox);
  if (fromOriginal) return fromOriginal;
  const to = pickRecipient(addressesIn(headers.to), mailbox);
  if (to) return to;
  return pickRecipient(addressesIn(headers.deliveredTo), mailbox);
}

export function cardLast4FromText(text) {
  const source = String(text || '');
  const labeled = source.match(/card\s+ending(?:\s+in)?\s*:?\s*(\d{4})\b/i);
  if (labeled) return labeled[1];
  const loose = source.match(/(?:ending(?:\s+in)?|last\s*4)[^\d]{0,16}(\d{4})\b/i);
  return loose ? loose[1] : null;
}

export function resolveCvsAccount({ subject = '', html = '', text = '', headers = {}, mailbox = '' } = {}) {
  const plain = `${htmlAsText(html)}\n${text || ''}`;
  const forwarded = isForwardedMessage({ subject, html, text });
  const forwardedTo = forwarded ? forwardedOriginalRecipient({ subject, html, text }) : null;
  const cvsAccountEmail = forwarded ? forwardedTo : envelopeRecipient(headers, mailbox);
  const normalizedMailbox = String(mailbox || '').trim().toLowerCase() || null;
  return {
    cvsAccountEmail: cvsAccountEmail || null,
    forwarded,
    cardLast4: cardLast4FromText(plain),
    mailbox: normalizedMailbox,
    otpReadable: otpReadableInMailbox(cvsAccountEmail, normalizedMailbox),
  };
}

export function verificationMatches({ from, recipient, internalDate } = {}, { expectedRecipient, afterMs, lookbackMs = VERIFICATION_LOOKBACK_MS } = {}) {
  if (String(from || '').trim().toLowerCase() !== VERIFICATION_SENDER) return false;
  const expected = String(expectedRecipient || '').trim().toLowerCase();
  const actual = String(recipient || '').trim().toLowerCase();
  if (!expected || actual !== expected) return false;
  const sent = Number(internalDate);
  const requested = Number(afterMs);
  const lookback = Number(lookbackMs);
  if (!Number.isFinite(sent) || !Number.isFinite(requested) || !Number.isFinite(lookback) || lookback < 0) return false;
  return sent >= requested - lookback;
}

export function selectMatchingCode(candidates, { expectedRecipient, afterMs, mailbox, lookbackMs = VERIFICATION_LOOKBACK_MS } = {}) {
  let best = null;
  for (const item of candidates || []) {
    const recipient = item.recipient || envelopeRecipient(item.headers || {}, mailbox);
    if (!verificationMatches({
      from: item.from,
      recipient,
      internalDate: item.internalDate,
    }, { expectedRecipient, afterMs, lookbackMs })) continue;
    if (!item.code) continue;
    if (!best || Number(item.internalDate) > Number(best.internalDate)) best = item;
  }
  return best ? best.code : null;
}
