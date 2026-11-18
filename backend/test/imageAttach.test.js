import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAttachment,
  applyBarcodeConfirmation,
  ATTACHED_LABEL,
  openCouponUrl,
  prepareAttachment,
} from '../src/imageAttach.js';

const welcome = {
  id: 'd88704405a00a138b92c',
  amount: 4,
  qualifier: 'off your purchase',
  expiresOn: '2026-11-25',
  cardLast4: '6145',
  cvsAccountEmail: 'joshua@creditandjourney.com',
  couponUrl: 'https://www.cvs.com/extracare/home',
  hasImage: false,
  imageKind: null,
  captureError: 'CVS refused sign-in before it sent a verification email.',
};

const other = {
  id: '5a029e8a4d18a603df8a',
  amount: 4,
  expiresOn: '2026-11-18',
  cardLast4: '0289',
  cvsAccountEmail: 'zimmjoshua@gmail.com',
  couponUrl: 'https://www.cvs.com/extracare/home',
  hasImage: false,
};

function pngData() {
  return `data:image/png;base64,${Buffer.alloc(100, 7).toString('base64')}`;
}

test('attaches a print image to the existing offer without copying another account', () => {
  const prepared = prepareAttachment({ imageData: pngData(), imageKind: 'code' });
  assert.equal(prepared.error, undefined);
  assert.equal(prepared.imageKind, 'attached');
  const offers = [welcome, other];
  const next = offers.map((offer) => (offer.id === welcome.id ? applyAttachment(offer, prepared) : offer));
  const saved = next.find((offer) => offer.id === welcome.id);
  const untouched = next.find((offer) => offer.id === other.id);
  assert.equal(saved.id, welcome.id);
  assert.equal(saved.cvsAccountEmail, 'joshua@creditandjourney.com');
  assert.equal(saved.cardLast4, '6145');
  assert.equal(saved.expiresOn, '2026-11-25');
  assert.equal(saved.amount, 4);
  assert.equal(saved.couponUrl, welcome.couponUrl);
  assert.equal(saved.imageKind, 'attached');
  assert.equal(saved.captureError, null);
  assert.equal(ATTACHED_LABEL.includes('verify barcode'), true);
  assert.equal(untouched.cardLast4, '0289');
  assert.equal(untouched.cvsAccountEmail, 'zimmjoshua@gmail.com');
  assert.equal(untouched.hasImage, false);
  assert.equal(next.length, 2);
});

test('rejects a bad upload and keeps the offer unchanged', () => {
  const prepared = prepareAttachment({ imageData: 'data:image/webp;base64,' + Buffer.alloc(100, 3).toString('base64') });
  assert.equal(prepared.error, 'Use a PNG or JPEG of the coupon screen.');
  assert.equal(prepareAttachment({ imageData: 'not-an-image' }).error, 'Use a PNG or JPEG of the coupon screen.');
  assert.equal(welcome.cardLast4, '6145');
  assert.equal(welcome.cvsAccountEmail, 'joshua@creditandjourney.com');
  assert.equal(openCouponUrl('https://www.cvs.com/extracare/home'), 'https://www.cvs.com/extracare/home');
  assert.equal(openCouponUrl('https://example.com/coupon'), '');
});

test('confirmation requires an attached image and does not change the account', () => {
  assert.equal(applyBarcodeConfirmation(welcome).error, 'Attach the print preview before confirming the barcode.');
  const attached = applyAttachment(welcome, prepareAttachment({ imageData: pngData() }));
  const confirmed = applyBarcodeConfirmation(attached);
  assert.equal(confirmed.imageKind, 'code');
  assert.equal(confirmed.id, welcome.id);
  assert.equal(confirmed.cardLast4, '6145');
  assert.equal(confirmed.cvsAccountEmail, welcome.cvsAccountEmail);
  assert.equal(confirmed.expiresOn, '2026-11-25');
  const verified = prepareAttachment({ imageData: pngData(), imageKind: 'code', barcodeVerified: true });
  assert.equal(verified.imageKind, 'code');
});
