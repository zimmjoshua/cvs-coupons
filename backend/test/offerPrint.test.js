import assert from 'node:assert/strict';
import test from 'node:test';
import {
  choosePrintTarget,
  isPrintAction,
  isRedeemAction,
  maskedCardLast4,
  printModalReady,
} from '../src/offerPrint.js';

const welcome = {
  amount: 4,
  qualifier: 'off a $10 purchase',
  expiresOn: '2026-11-25',
  cardLast4: '6145',
};

test('prints only the matching offer and ignores redeem controls', () => {
  assert.equal(maskedCardLast4('ExtraCare card ***6145'), '6145');
  assert.equal(isRedeemAction('Send to card'), true);
  assert.equal(isPrintAction('Print $4.00 off', 4), true);
  assert.equal(isRedeemAction('Print $4.00 off'), false);

  const chosen = choosePrintTarget([
    {
      name: 'Print $4.00 off',
      block: '$4 off your purchase exp 12/01/2026 Print $4.00 off',
    },
    {
      name: 'Send to card',
      block: '$4 off your $10 Purchase exp 11/25/2026 Send to card',
    },
    {
      name: 'Print $4.00 off',
      block: '$4 off your $10 Purchase exp 11/25/2026 Print $4.00 off',
    },
  ], welcome);

  assert.equal(chosen.block.includes('11/25/2026'), true);
  assert.equal(choosePrintTarget([{ name: 'Print $2.00 off', block: '$2 off exp 11/25/2026' }], welcome), null);
});

test('saves a print modal only when its barcode belongs to that offer', () => {
  const ready = printModalReady({
    title: '$4.00 off',
    barcodeName: 'barcode to scan at register',
    amount: 4,
    offerCard: '6145',
    pageCard: '6145',
  });
  const product = printModalReady({
    title: '$4.00 off',
    barcodeName: 'Vitamin C gummies',
    amount: 4,
    offerCard: '6145',
    pageCard: '6145',
  });
  const otherCard = printModalReady({
    title: '$4.00 off',
    barcodeName: 'barcode to scan at register',
    amount: 4,
    offerCard: '6145',
    pageCard: '0289',
  });

  assert.equal(ready.ok, true);
  assert.equal(ready.reason, 'print-modal');
  assert.equal(product.ok, false);
  assert.equal(product.reason, 'unverified-image');
  assert.equal(otherCard.ok, false);
  assert.equal(otherCard.reason, 'wrong-card');
});
