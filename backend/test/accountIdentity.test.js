import assert from 'node:assert/strict';
import test from 'node:test';
import {
  envelopeRecipient,
  otpReadableInMailbox,
  resolveCvsAccount,
  selectMatchingCode,
  verificationMatches,
} from '../src/accountIdentity.js';

const mailbox = 'joshua@creditandjourney.com';

test('uses a catch-all alias from To when Delivered-To is the connected mailbox', () => {
  const account = resolveCvsAccount({
    subject: 'Yay! Your $4 Welcome Reward Is Here',
    text: 'Card ending in: 6145',
    headers: {
      to: { value: [{ address: 'shopper@creditandjourney.com' }] },
      deliveredTo: 'joshua@creditandjourney.com',
    },
    mailbox,
  });
  assert.equal(account.cvsAccountEmail, 'shopper@creditandjourney.com');
  assert.equal(account.forwarded, false);
  assert.equal(account.cardLast4, '6145');
  assert.equal(account.otpReadable, true);
  assert.notEqual(account.cvsAccountEmail, mailbox);
});

test('direct catch-all mail keeps the alias CVS sent, including the connected mailbox itself', () => {
  const account = resolveCvsAccount({
    subject: 'Yay! Your $4 Welcome Reward Is Here...',
    text: 'Card ending in: 6145',
    headers: {
      to: 'joshua@creditandjourney.com',
      deliveredTo: 'joshua@creditandjourney.com',
    },
    mailbox,
  });
  assert.equal(account.cvsAccountEmail, 'joshua@creditandjourney.com');
  assert.equal(account.forwarded, false);
  assert.equal(account.cardLast4, '6145');
  assert.equal(account.otpReadable, true);
  assert.equal(account.mailbox, mailbox);
});

test('prefers X-Original-To over the mailbox in To and Delivered-To', () => {
  const recipient = envelopeRecipient({
    xOriginalTo: 'alias@creditandjourney.com',
    to: mailbox,
    deliveredTo: mailbox,
  }, mailbox);
  assert.equal(recipient, 'alias@creditandjourney.com');
});

test('uses the forwarded original recipient and does not treat an outside domain as catch-all mail', () => {
  const account = resolveCvsAccount({
    subject: 'Fwd: $4 Coupon!',
    html: `
      <div>Begin forwarded message:</div>
      <div>From: CVS ExtraCare &lt;extracare@mystore.cvs.com&gt;</div>
      <div>To: zimmjoshua@gmail.com</div>
      <div>Card ending in: 0289</div>
    `,
    headers: {
      to: mailbox,
      deliveredTo: mailbox,
    },
    mailbox,
  });
  assert.equal(account.forwarded, true);
  assert.equal(account.cvsAccountEmail, 'zimmjoshua@gmail.com');
  assert.equal(account.cardLast4, '0289');
  assert.equal(account.otpReadable, false);
});

test('a forwarded catch-all alias still receives its code in the connected mailbox', () => {
  const account = resolveCvsAccount({
    subject: 'Fwd: $2 Coupon!',
    text: 'Begin forwarded message:\nTo: deals@creditandjourney.com\nCard ending in: 1111',
    headers: { to: mailbox, deliveredTo: mailbox },
    mailbox,
  });
  assert.equal(account.cvsAccountEmail, 'deals@creditandjourney.com');
  assert.equal(account.otpReadable, true);
});

test('does not guess the mailbox when a forward has no original recipient', () => {
  const account = resolveCvsAccount({
    subject: 'Fwd: $4 Coupon!',
    text: 'Begin forwarded message:\nFrom: extracare@mystore.cvs.com',
    headers: { to: mailbox, deliveredTo: mailbox },
    mailbox,
  });
  assert.equal(account.cvsAccountEmail, null);
  assert.equal(account.otpReadable, false);
});

test('rejects another alias code that landed in the same catch-all mailbox', () => {
  const requestedAt = 1_700_000_000_000;
  const messages = [
    {
      from: 'info@alerts.cvs.com',
      headers: { to: 'shopper@creditandjourney.com', deliveredTo: mailbox },
      internalDate: requestedAt + 1000,
      code: '111111',
    },
    {
      from: 'info@alerts.cvs.com',
      headers: { to: 'deals@creditandjourney.com', deliveredTo: mailbox },
      internalDate: requestedAt + 2000,
      code: '222222',
    },
    {
      from: 'info@alerts.cvs.com',
      headers: { to: 'shopper@creditandjourney.com', deliveredTo: mailbox },
      internalDate: requestedAt - 120000,
      code: '333333',
    },
  ];
  const shopper = selectMatchingCode(messages, {
    expectedRecipient: 'shopper@creditandjourney.com',
    afterMs: requestedAt,
    mailbox,
  });
  const deals = selectMatchingCode(messages, {
    expectedRecipient: 'deals@creditandjourney.com',
    afterMs: requestedAt,
    mailbox,
  });
  const mailboxAccount = selectMatchingCode(messages, {
    expectedRecipient: mailbox,
    afterMs: requestedAt,
    mailbox,
  });
  assert.equal(shopper, '111111');
  assert.equal(deals, '222222');
  assert.notEqual(shopper, deals);
  assert.equal(mailboxAccount, null);
});

test('matches a fresh code for the requested alias only', () => {
  const requestedAt = 1_700_000_000_000;
  assert.equal(verificationMatches({
    from: 'info@alerts.cvs.com',
    recipient: 'shopper@creditandjourney.com',
    internalDate: requestedAt + 2000,
  }, { expectedRecipient: 'shopper@creditandjourney.com', afterMs: requestedAt }), true);
  assert.equal(otpReadableInMailbox('shopper@creditandjourney.com', mailbox), true);
  assert.equal(verificationMatches({
    from: 'info@alerts.cvs.com',
    recipient: 'other@creditandjourney.com',
    internalDate: requestedAt + 2000,
  }, { expectedRecipient: 'shopper@creditandjourney.com', afterMs: requestedAt }), false);
  assert.equal(verificationMatches({
    from: 'info@alerts.cvs.com',
    recipient: 'shopper@creditandjourney.com',
    internalDate: requestedAt - 60000,
  }, { expectedRecipient: 'shopper@creditandjourney.com', afterMs: requestedAt }), false);
  assert.equal(verificationMatches({
    from: 'someone@gmail.com',
    recipient: 'shopper@creditandjourney.com',
    internalDate: requestedAt + 2000,
  }, { expectedRecipient: 'shopper@creditandjourney.com', afterMs: requestedAt }), false);
});
