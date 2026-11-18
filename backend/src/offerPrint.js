const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function maskedCardLast4(text) {
  const source = String(text || '');
  const labeled = source.match(/card\s+ending(?:\s+in)?\s*:?\s*(\d{4})\b/i);
  if (labeled) return labeled[1];
  const stars = source.match(/(?:\*{2,}|•{2,})\s*(\d{4})\b/);
  return stars ? stars[1] : null;
}

export function isRedeemAction(name) {
  return /send to card|redeem|get coupon|clip coupon|add to card/i.test(String(name || ''));
}

export function isPrintAction(name, amount) {
  const dollars = Number(amount).toFixed(2);
  return new RegExp(String.raw`^print\s+\$${dollars}\s+off\b`, 'i').test(String(name || '').replace(/\s+/g, ' ').trim());
}

function expiryShown(text, expiresOn) {
  if (!expiresOn) return true;
  const [year, month, day] = String(expiresOn).split('-').map(Number);
  if (!year || !month || !day) return true;
  const source = String(text || '');
  const short = `${month}/${day}/${year}`;
  const padded = `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
  if (source.includes(short) || source.includes(padded)) return true;
  const monthName = MONTHS[month - 1];
  return new RegExp(`${monthName}\\s+${day},?\\s+${year}`, 'i').test(source);
}

export function offerBlockMatches(blockText, offer = {}) {
  const text = String(blockText || '').replace(/\s+/g, ' ');
  const amount = Number(offer.amount);
  if (!Number.isInteger(amount)) return false;
  if (!new RegExp(String.raw`\$${amount}(?:\.00)?\s+off\b`, 'i').test(text)) return false;
  if (offer.expiresOn && !expiryShown(text, offer.expiresOn)) return false;
  const minimum = String(offer.qualifier || '').match(/\$(\d+)/);
  if (minimum && !new RegExp(String.raw`\$${minimum[1]}\b`).test(text)) return false;
  const blockCard = maskedCardLast4(text);
  if (offer.cardLast4 && blockCard && blockCard !== offer.cardLast4) return false;
  return true;
}

export function choosePrintTarget(candidates, offer) {
  return (candidates || []).find((item) => {
    const name = item?.name || '';
    return isPrintAction(name, offer?.amount) && !isRedeemAction(name) && offerBlockMatches(item?.block, offer);
  }) || null;
}

export function isPrintBarcodeName(name) {
  return /barcode to scan at register/i.test(String(name || ''));
}

export function printModalReady({ title = '', barcodeName = '', amount, offerCard, pageCard } = {}) {
  if (offerCard && pageCard && offerCard !== pageCard) return { ok: false, reason: 'wrong-card' };
  if (!isPrintBarcodeName(barcodeName)) return { ok: false, reason: 'unverified-image' };
  const dollars = Number(amount).toFixed(2);
  if (!new RegExp(String.raw`\$${dollars}\s+off\b`, 'i').test(String(title || ''))) {
    return { ok: false, reason: 'wrong-offer' };
  }
  return { ok: true, reason: 'print-modal' };
}
