import { couponUrlAllowed } from './urls.js';

export function decodeImage(dataUrl) {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl || '');
  if (!match) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (buffer.length < 80 || buffer.length > 8_000_000) return null;
  const kind = match[1].toLowerCase();
  const mime = kind === 'png' ? 'image/png' : kind === 'webp' ? 'image/webp' : 'image/jpeg';
  return { mime, data: buffer.toString('base64') };
}

export const ATTACHED_LABEL = 'Image attached — verify barcode';

export function openCouponUrl(url) {
  return couponUrlAllowed(url) ? url : '';
}

export function prepareAttachment(body = {}) {
  const image = decodeImage(body.imageData);
  if (!image || (image.mime !== 'image/png' && image.mime !== 'image/jpeg')) {
    return { error: 'Use a PNG or JPEG of the coupon screen.' };
  }
  const verified = body.barcodeVerified === true && (body.imageKind === 'code' || body.imageKind === 'confirmation');
  return {
    ...image,
    imageKind: verified ? body.imageKind : 'attached',
  };
}

export function applyAttachment(offer, prepared) {
  return {
    ...offer,
    hasImage: true,
    imageKind: prepared.imageKind,
    captureError: null,
  };
}

export function applyBarcodeConfirmation(offer) {
  if (!offer?.hasImage) return { error: 'Attach the print preview before confirming the barcode.' };
  return { ...offer, imageKind: 'code' };
}
