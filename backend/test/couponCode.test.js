import assert from 'node:assert/strict';
import test from 'node:test';
import { couponCodeEvidence } from '../src/couponCode.js';

test('rejects ordinary square and product images without barcode evidence', () => {
  const squareProduct = couponCodeEvidence({
    label: 'Vitamin C gummies product photo',
    width: 240,
    height: 240,
    pageKind: 'other',
  });
  const squareOnCouponPage = couponCodeEvidence({
    label: 'store brand lotion',
    width: 200,
    height: 200,
    pageKind: 'coupon',
  });
  const wideLogo = couponCodeEvidence({
    label: 'CVS logo',
    width: 320,
    height: 80,
    pageKind: 'coupon',
  });
  const labeledButNotACouponPage = couponCodeEvidence({
    label: 'QR code',
    width: 220,
    height: 220,
    pageKind: 'other',
  });

  assert.equal(squareProduct.ok, false);
  assert.equal(squareProduct.reason, 'unverified-image');
  assert.equal(squareOnCouponPage.ok, false);
  assert.equal(wideLogo.ok, false);
  assert.equal(labeledButNotACouponPage.ok, false);
});

test('accepts a decoded barcode or an explicit QR label on a coupon page', () => {
  const decoded = couponCodeEvidence({
    label: 'store brand lotion',
    width: 220,
    height: 220,
    decoded: true,
    pageKind: 'coupon',
  });
  const labeled = couponCodeEvidence({
    label: 'Your QR code',
    width: 220,
    height: 220,
    pageKind: 'coupon',
  });

  assert.equal(decoded.ok, true);
  assert.equal(decoded.reason, 'decoded');
  assert.equal(labeled.ok, true);
  assert.equal(labeled.reason, 'labeled');
});
