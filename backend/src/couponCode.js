export const BARCODE_LABEL_SOURCE = '\\bqr[\\s_-]?code\\b|\\bqrcode\\b|\\bqr\\b|\\bbarcode\\b|\\bbar[\\s_-]?code\\b';
const BARCODE_LABEL = new RegExp(BARCODE_LABEL_SOURCE, 'i');

export function hasBarcodeLabel(label) {
  return BARCODE_LABEL.test(String(label || ''));
}

export function couponCodeEvidence({ label = '', width = 0, height = 0, decoded = false, pageKind = 'other' } = {}) {
  if (pageKind === 'captcha' || pageKind === 'error' || pageKind === 'login') {
    return { ok: false, reason: 'unverified-image' };
  }
  if (decoded) return { ok: true, reason: 'decoded' };
  const labeled = hasBarcodeLabel(label);
  const visibleCode = width >= 80 && height >= 40 && width <= 640 && height <= 640;
  if (labeled && pageKind === 'coupon' && visibleCode) return { ok: true, reason: 'labeled' };
  return { ok: false, reason: 'unverified-image' };
}
