import crypto from 'node:crypto';
import * as cheerio from 'cheerio';

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function dollarOffAmounts(text) {
  return [...String(text).matchAll(/\$(\d+)(?!\d)(?:\.00)?\s*off\b/gi)].map((match) => Number(match[1]));
}

export function subjectAmount(subject) {
  const match = String(subject || '').match(/\$([24])(?!\d)/);
  return match ? Number(match[1]) : null;
}

function chooseAmount(context, subject) {
  const dollars = [...new Set(dollarOffAmounts(context))];
  const wanted = dollars.filter((amount) => amount === 2 || amount === 4);
  if (wanted.length === 1 && dollars.length === 1) return wanted[0];
  if (dollars.length >= 1) return null;
  return subjectAmount(subject);
}

function bestQualifier(amount, context, fullText) {
  const fromContext = qualifierFor(amount, context);
  if (fromContext !== 'off your purchase') return fromContext;
  return qualifierFor(amount, fullText);
}

function qualifierFor(amount, text) {
  const source = String(text || '');
  const entire = new RegExp(String.raw`\$${amount}(?:\.00)?\s*off\s+your\s+entire\s+purchase`, 'i');
  if (entire.test(source)) return 'off your entire purchase';
  const minimum = source.match(new RegExp(
    String.raw`\$${amount}(?:\.00)?\s*off\s+(?:(?:your|a|an)\s+)?\$(\d+)(?:\.00)?`,
    'i',
  ));
  if (minimum) return `off a $${Number(minimum[1])} purchase`;
  if (/entire purchase/i.test(source)) return 'off your entire purchase';
  return 'off your purchase';
}

export function extractExpiry(text) {
  const source = String(text || '');
  const named = source.match(
    /(?:redeem(?:\s+through)?|valid(?:\s+through)?|expires?(?:\s+on)?|offer\s+ends(?:\s+on)?)\s+(?:[A-Za-z]+day,?\s+)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number(named[2]);
    const year = Number(named[3]);
    if (month && day >= 1 && day <= 31 && year >= 2020) {
      return {
        expiresOn: isoDate(year, month, day),
        expiresLabel: `${named[1]} ${day}, ${year}`,
      };
    }
  }
  const numeric = source.match(
    /(?:redeem(?:\s+through)?|valid(?:\s+through)?|expires?(?:\s+on)?)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
  );
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    const year = Number(numeric[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { expiresOn: isoDate(year, month, day), expiresLabel: `${month}/${day}/${year}` };
    }
  }
  return { expiresOn: null, expiresLabel: null };
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cardLast4(text) {
  const match = String(text || '').match(/(?:ending(?:\s+in)?|last\s*4|card(?:\s+number)?)[^\d]{0,20}(\d{4})\b/i);
  return match ? match[1] : null;
}

function looksLikeCoupon(text) {
  return /coupon|extracare|extra care|redeem through/i.test(text);
}

function ignored(href, label) {
  const blob = `${href} ${label}`.toLowerCase();
  return /unsub|privacy|opt-?out|facebook|instagram|twitter|tiktok|youtube|pinterest|linkedin|view online|view in your browser|view in browser|email preferences|photo cards?|photo print|minuteclinic|prescription/.test(
    blob,
  );
}

function isCta(label, href) {
  const blob = `${label} ${href}`.toLowerCase();
  return /get\s+coupon|send\s+to\s+(?:your\s+)?card|send\s+this|add\s+to\s+card|clip\s+coupon|load\s+coupon|send2card|send-to-card|getcoupon|get-coupon/.test(
    blob,
  );
}

function labelOf($, el) {
  const node = $(el);
  const alts = node
    .find('img')
    .map((_, img) => $(img).attr('alt') || '')
    .get()
    .join(' ');
  return clean(`${node.text()} ${alts} ${node.attr('aria-label') || ''} ${node.attr('title') || ''}`);
}

function climb($, el) {
  let node = $(el);
  let best = labelOf($, el);
  for (let i = 0; i < 8; i += 1) {
    const parent = node.parent();
    if (!parent.length || parent.is('body') || parent.is('html')) break;
    const text = clean(parent.text());
    const amounts = dollarOffAmounts(text);
    if (new Set(amounts).size > 1) break;
    if (text.length > 900) break;
    best = text;
    node = parent;
    if (amounts.length >= 1 && /redeem|expires|valid through|entire purchase/i.test(text)) break;
  }
  return best;
}

function offerFromParts({ subject, context, href, messageId, from, receivedAt, fullText }) {
  const amount = chooseAmount(context, subject);
  if (amount !== 2 && amount !== 4) return null;
  const expirySource = /redeem|expires|valid through/i.test(context) ? context : `${context}\n${fullText}`;
  const expiry = extractExpiry(expirySource);
  const qualifier = bestQualifier(amount, /off/i.test(context) ? context : fullText, fullText);
  return {
    id: crypto.createHash('sha256').update(`${messageId}|${href || ''}|${amount}`).digest('hex').slice(0, 20),
    messageId,
    amount,
    qualifier,
    expiresOn: expiry.expiresOn,
    expiresLabel: expiry.expiresLabel,
    cardLast4: cardLast4(`${context}\n${fullText}`),
    couponUrl: href || null,
    subject: clean(subject).slice(0, 180),
    from,
    receivedAt,
  };
}

function offersFromHtml(html, meta, fullText) {
  const $ = cheerio.load(html);
  const found = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    const href = clean($(el).attr('href'));
    if (!/^https?:\/\//i.test(href)) return;
    const label = labelOf($, el);
    if (ignored(href, label) || !isCta(label, href)) return;
    if (seen.has(href)) return;
    const context = climb($, el);
    const offer = offerFromParts({ ...meta, context, href, fullText });
    if (!offer) return;
    seen.add(href);
    found.push(offer);
  });
  return found;
}

function offersFromText(text, meta, fullText) {
  const found = [];
  const seen = new Set();
  const matches = String(text).matchAll(/https?:\/\/[^\s<>"']+/gi);
  for (const match of matches) {
    const href = match[0].replace(/&amp;/g, '&').replace(/[),.;]+$/, '');
    const start = Math.max(0, match.index - 240);
    const context = clean(String(text).slice(start, match.index + href.length));
    if (ignored(href, context) || !isCta(context, href)) continue;
    if (seen.has(href)) continue;
    const offer = offerFromParts({ ...meta, context, href, fullText });
    if (!offer) continue;
    seen.add(href);
    found.push(offer);
  }
  return found;
}

export function parseCouponEmail({ subject = '', html = '', text = '', messageId = '', from = '', date = null }) {
  const receivedAt = date ? new Date(date).toISOString() : null;
  const safeId = messageId || crypto.createHash('sha256').update(`${subject}|${receivedAt}|${text.slice(0, 200)}`).digest('hex');
  const plain = clean(text || '');
  const htmlText = html ? clean(cheerio.load(html).text()) : '';
  const fullText = clean(`${subject}\n${plain}\n${htmlText}`);
  if (!looksLikeCoupon(fullText)) return [];

  const meta = { subject, messageId: safeId, from, receivedAt, fullText };
  let offers = html ? offersFromHtml(html, meta, fullText) : [];
  if (!offers.length && plain) offers = offersFromText(plain, meta, fullText);

  if (!offers.length) {
    const dollars = [...new Set(dollarOffAmounts(fullText))];
    const wanted = dollars.filter((amount) => amount === 2 || amount === 4);
    const other = dollars.some((amount) => amount !== 2 && amount !== 4);
    const amount = wanted.length === 1 ? wanted[0] : subjectAmount(subject);
    if (!other && (amount === 2 || amount === 4) && (wanted.length === 0 || wanted.includes(amount))) {
      const offer = offerFromParts({ ...meta, context: fullText, href: '', fullText });
      if (offer) offers = [offer];
    }
  }

  return offers.slice(0, 5);
}
