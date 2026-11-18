import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCouponEmail } from '../src/parseCoupon.js';

const html = `
  <a href="https://click.email.cvs.com/?qs=unsub">Unsubscribe</a>
  <table>
    <tr><td>
      <p>$4 off your entire purchase*</p>
      <a href="https://click.email.cvs.com/?qs=coupon4"><img alt="Get coupon" src="btn.png"></a>
      <p>Redeem through Wednesday, November 18, 2026</p>
    </td></tr>
    <tr><td>
      <a href="https://www.cvs.com/photo/holiday"><img alt="Shop photo cards"></a>
    </td></tr>
    <tr><td>
      <p>$5 off your entire purchase</p>
      <a href="https://click.email.cvs.com/?qs=coupon5">Get coupon</a>
      <p>Redeem through December 1, 2026</p>
    </td></tr>
    <tr><td>
      <p>$2 off your entire purchase</p>
      <a href="https://click.email.cvs.com/?qs=coupon2">Send to card</a>
      <p>Redeem through December 2, 2026</p>
    </td></tr>
    <tr><td>
      <p>$4 off $20</p>
      <a href="https://click.email.cvs.com/?qs=coupon20">Get coupon</a>
      <p>Expires on January 5, 2027</p>
    </td></tr>
  </table>
`;

test('keeps $2 and $4 coupon links and skips the other offers', () => {
  const offers = parseCouponEmail({
    subject: '$4 Coupon!',
    html,
    text: '',
    messageId: '<coupon@email.cvs.com>',
    from: 'cvs-extracare@email.cvs.com',
    date: '2026-11-12T14:00:00Z',
  });

  assert.deepEqual(
    offers.map((offer) => ({
      amount: offer.amount,
      qualifier: offer.qualifier,
      expiresOn: offer.expiresOn,
      url: offer.couponUrl,
    })),
    [
      {
        amount: 4,
        qualifier: 'off your entire purchase',
        expiresOn: '2026-11-18',
        url: 'https://click.email.cvs.com/?qs=coupon4',
      },
      {
        amount: 2,
        qualifier: 'off your entire purchase',
        expiresOn: '2026-12-02',
        url: 'https://click.email.cvs.com/?qs=coupon2',
      },
      {
        amount: 4,
        qualifier: 'off a $20 purchase',
        expiresOn: '2027-01-05',
        url: 'https://click.email.cvs.com/?qs=coupon20',
      },
    ],
  );
});

test('ignores emails that are not $2 or $4 coupons', () => {
  const offers = parseCouponEmail({
    subject: '$10 Coupon!',
    html: '<p>$10 off your entire purchase</p><a href="https://click.email.cvs.com/?qs=ten">Get coupon</a>',
    messageId: '<ten@email.cvs.com>',
  });
  assert.equal(offers.length, 0);
});

test('parses a forwarded $4 Coupon email from CVS ExtraCare', () => {
  const offers = parseCouponEmail({
    subject: 'Fwd: $4 Coupon!',
    text: `Begin forwarded message:
From: CVS ExtraCare <extracare@mystore.cvs.com>
Subject: $4 Coupon!
$4 off your entire purchase
Get coupon https://click.email.cvs.com/?qs=forwarded
Redeem through Wednesday, November 18, 2026`,
    messageId: '<fwd@gmail.com>',
    from: 'zimmjoshua@gmail.com',
  });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].amount, 4);
  assert.equal(offers[0].expiresOn, '2026-11-18');
  assert.equal(offers[0].couponUrl, 'https://click.email.cvs.com/?qs=forwarded');
});

test('uses the real minimum and ignores a repeated dollar amount before entire purchase', () => {
  const welcome = parseCouponEmail({
    subject: 'Yay! Your $4 Welcome Reward Is Here...',
    text: '$4 off your $10 purchase coupon. Redeem through November 25, 2026. FOR $4 OFF $10 OFFER: ExtraCare card required. Card ending in: 6145. Get coupon https://click.web.cvs.com/?qs=welcome',
    messageId: '<welcome@cvs.com>',
    from: 'extracare@mynotifications.cvs.com',
  });
  assert.equal(welcome.length, 1);
  assert.equal(welcome[0].qualifier, 'off a $10 purchase');
  assert.equal(welcome[0].cardLast4, '6145');
  assert.equal(welcome[0].expiresOn, '2026-11-25');
  assert.equal(welcome[0].couponUrl, 'https://click.web.cvs.com/?qs=welcome');

  const forwarded = parseCouponEmail({
    subject: 'Fwd: $4 Coupon!',
    text: 'My deals rewards $4 off $4 off your entire purchase* Get coupon https://click.web.cvs.com/?qs=forward Card ending in: 0289 Redeem through Wednesday, November 18, 2026.',
    messageId: '<fwd@gmail.com>',
    from: 'zimmjoshua@gmail.com',
  });
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].qualifier, 'off your entire purchase');
  assert.equal(forwarded[0].cardLast4, '0289');
  assert.equal(forwarded[0].couponUrl, 'https://click.web.cvs.com/?qs=forward');
});

test('reads a plain-text coupon link', () => {
  const offers = parseCouponEmail({
    subject: 'ExtraCare',
    text: 'Get coupon https://click.email.cvs.com/?qs=plain\n$2 off your entire purchase\nRedeem through November 20, 2026',
    messageId: '<plain@email.cvs.com>',
  });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].amount, 2);
  assert.equal(offers[0].expiresOn, '2026-11-20');
});
