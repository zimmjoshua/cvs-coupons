import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mailboxDomain, otpReadableInMailbox } from './accountIdentity.js';
import { waitForVerificationCode } from './gmail.js';
import { choosePrintTarget, maskedCardLast4, printModalReady } from './offerPrint.js';
import {
  canSendCode,
  dobHandoffStatus,
  EMAIL_RADIO_NAME,
  isDobChallenge,
  isEmailRadioName,
  isPasskeyEnrollment,
  nextAfterCodeAccepted,
  planEmailDelivery,
  shouldStartCodePoll,
} from './signInFlow.js';
import { couponUrlAllowed, urlHost } from './urls.js';

const profilesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/chrome-profiles');
const emailSelector = 'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="username"]';

function accountEmail(offer) {
  const email = String(offer?.cvsAccountEmail || '').trim().toLowerCase();
  return email || null;
}

function groupOffers(offers) {
  const groups = [];
  const index = new Map();
  for (const offer of offers) {
    const email = accountEmail(offer) || '';
    if (!index.has(email)) {
      index.set(email, groups.length);
      groups.push({ email, offers: [] });
    }
    groups[index.get(email)].offers.push(offer);
  }
  return groups;
}

function profileDirFor(email) {
  const id = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
  return path.join(profilesRoot, id);
}

function publicSnippet(text, limit = 180) {
  return String(text || '')
    .replace(/\b\d{6}\b/g, '######')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function looksLikeCoupon(text) {
  return /barcode|qr code|scan this|show (?:this |the )?coupon/i.test(text);
}

function pageKind(text) {
  const source = String(text || '');
  if (/recaptcha|captcha|verify you are human|i['’]m not a robot|are you a robot/i.test(source)) return 'captcha';
  if (/there['’]s a problem on our end|something went wrong|technical difficult/i.test(source)) return 'error';
  if (/verification code|enter the code|6-digit|one-time code/i.test(source)) return 'login';
  if (looksLikeCoupon(source)) return 'coupon';
  if (/sign out/i.test(source)) return 'account';
  if (/sign in|log in|enter your email/i.test(source)) return 'login';
  return 'other';
}

function shownCard(text) {
  return maskedCardLast4(text);
}

function identityOk(text, email, cardLast4) {
  const body = String(text || '');
  if (email && body.toLowerCase().includes(String(email).toLowerCase())) return true;
  const card = shownCard(body);
  return Boolean(cardLast4 && card === cardLast4);
}

function blockerMessage(email, result) {
  if (result.blocker === 'network') {
    return `CVS refused sign-in for ${email} before it sent a verification email. ${result.detail || 'The page reported a network-address problem.'} The coupon was not captured.`;
  }
  if (result.blocker === 'captcha') {
    return `CVS is showing a CAPTCHA for ${email}. A person has to complete it in the Chrome window. The coupon was not captured.`;
  }
  if (result.blocker === 'cvs-error') {
    return `CVS showed an error page before ${email} was verified${result.detail ? `: ${result.detail}` : ''}. The coupon was not captured.`;
  }
  if (result.blocker === 'no-code') {
    return `No new CVS verification email addressed to ${email} arrived in the connected mailbox after the code was requested${result.detail ? `. Page: ${result.detail}` : ''}. The coupon was not captured.`;
  }
  if (result.blocker === 'no-email-field') {
    return `CVS did not show an email field for ${email}${result.detail ? `: ${result.detail}` : ''}. The coupon was not captured.`;
  }
  if (result.blocker === 'code-field') {
    return `A new verification email for ${email} arrived, but the code field was not on the page. The coupon was not captured.`;
  }
  if (result.blocker === 'wrong-card') {
    return `The signed-in ExtraCare card does not match this coupon${result.detail ? ` (${result.detail})` : ''}. The coupon was not captured.`;
  }
  if (result.blocker === 'unverified') {
    return `Sign-in for ${email} did not show that account's email or ExtraCare card. The coupon was not opened.`;
  }
  if (result.blocker === 'login') {
    return `CVS still showed the sign-in page for ${email}. The coupon was not captured.`;
  }
  if (result.blocker === 'email-delivery') {
    return `CVS did not send an email code for ${email}. Email has to be selected on its own, and then Send code, before a code is requested${result.detail ? `: ${result.detail}` : ''}. The coupon was not captured.`;
  }
  if (result.blocker === 'dob') {
    return `The date-of-birth check for ${email} is still open in Chrome. Enter it in that window. The coupon was not captured.`;
  }
  if (result.blocker === 'passkey') {
    return `CVS asked ${email} to create a passkey. Not now was not confirmed, so no passkey was enrolled and the coupon was not captured.`;
  }
  if (result.blocker === 'print') {
    return `The print preview for ${email} did not show this offer's barcode. Send to card and redeem were not clicked, and nothing was saved.`;
  }
  return result.detail || `Sign-in for ${email} did not finish. The coupon was not captured.`;
}

async function launchContext(email) {
  const { chromium } = await import('playwright');
  const profileDir = profileDirFor(email);
  fs.mkdirSync(profileDir, { recursive: true });
  const options = {
    headless: process.env.HEADLESS === '1',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  };
  try {
    return await chromium.launchPersistentContext(profileDir, { ...options, channel: 'chrome' });
  } catch {
    return await chromium.launchPersistentContext(profileDir, options);
  }
}

async function pageEvidence(page) {
  return page.evaluate(() => (document.body?.innerText || '').slice(0, 20000)).catch(() => '');
}

async function dismissOverlays(page) {
  for (let i = 0; i < 3; i += 1) {
    const close = page.getByRole('button', { name: /^(close|ok)$/i }).or(page.getByRole('link', { name: /^close$/i }));
    if (!(await close.count())) break;
    await close.first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function findLocator(page, selector) {
  for (const frame of page.frames()) {
    try {
      const locator = frame.locator(selector).first();
      if (await locator.count()) return locator;
    } catch {
      // The login page replaces frames while it redirects.
    }
  }
  return null;
}

async function clickNamed(page, pattern) {
  const locator = page.getByRole('button', { name: pattern }).or(page.getByRole('link', { name: pattern }));
  if (!(await locator.count())) return false;
  await locator.first().click({ timeout: 8000 }).catch(() => {});
  return true;
}

async function readDeliveryRadios(page) {
  return page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type="radio"], [role="radio"]')];
    return radios.map((node) => {
      const explicit = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : null;
      const wrapping = node.closest('label');
      const name = (explicit?.innerText || wrapping?.innerText || node.getAttribute('aria-label') || node.getAttribute('value') || '')
        .replace(/\s+/g, ' ')
        .trim();
      const selected = node.getAttribute('role') === 'radio'
        ? node.getAttribute('aria-checked') === 'true'
        : Boolean(node.checked);
      return { name, selected };
    }).filter((radio) => radio.name);
  }).catch(() => []);
}

async function emailRadioSelected(page) {
  const radio = page.getByRole('radio', { name: EMAIL_RADIO_NAME });
  if (await radio.count()) {
    const checked = await radio.first().isChecked().catch(() => false);
    if (checked) return true;
  }
  const radios = await readDeliveryRadios(page);
  return radios.some((item) => isEmailRadioName(item.name) && item.selected);
}

async function selectEmailRadio(page) {
  const radio = page.getByRole('radio', { name: EMAIL_RADIO_NAME });
  if (await radio.count()) {
    await radio.first().check({ timeout: 5000 }).catch(async () => {
      await radio.first().click({ timeout: 5000 });
    });
  } else {
    const label = page.locator('label').filter({ hasText: EMAIL_RADIO_NAME });
    if (!(await label.count())) return false;
    await label.first().click({ timeout: 5000 }).catch(() => {});
  }
  return emailRadioSelected(page);
}

async function waitForDeliveryChoice(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await page.getByRole('radio', { name: EMAIL_RADIO_NAME }).count().catch(() => 0)) return 'choices';
    if (await page.locator('label').filter({ hasText: EMAIL_RADIO_NAME }).count().catch(() => 0)) return 'choices';
    const text = await pageEvidence(page);
    if (/problem with your network address|can[’']t sign you in right now/i.test(text)) return 'network';
    await page.waitForTimeout(400);
  }
  return 'missing';
}

async function sendEmailCode(page) {
  const radios = await readDeliveryRadios(page);
  const plan = planEmailDelivery(radios);
  const emailSelected = await selectEmailRadio(page);
  if (!plan.ok && !emailSelected) return { ok: false, detail: 'The Email option was not on the page.' };
  if (!canSendCode({ emailSelected })) return { ok: false, detail: 'Email was not selected. Text stays the default until Email is chosen.' };
  const requestedAt = Date.now();
  const sent = await clickNamed(page, /^send code$/i);
  if (!sent || !shouldStartCodePoll({ emailSelected: true, sendClicked: sent })) {
    return { ok: false, detail: 'Send code was not clicked after Email was selected.' };
  }
  return { ok: true, requestedAt };
}

function pathnameOf(page) {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return '';
  }
}

async function fillCode(page, code) {
  const pathname = pathnameOf(page);
  const text = await pageEvidence(page);
  if (isDobChallenge({ pathname, text })) return false;
  for (const frame of page.frames()) {
    const boxes = frame.locator('input[maxlength="1"]');
    if (await boxes.count() >= 6) {
      for (let i = 0; i < 6; i += 1) await boxes.nth(i).fill(code[i]);
      return true;
    }
    const field = frame.locator('input[autocomplete="one-time-code"]').first();
    if (await field.count()) {
      await field.fill(code);
      return true;
    }
  }
  return false;
}

async function waitForCodeField(page, shouldStop) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (shouldStop?.()) return false;
    const pathname = pathnameOf(page);
    const text = await pageEvidence(page);
    if (isDobChallenge({ pathname, text })) return false;
    if (await findLocator(page, 'input[maxlength="1"], input[autocomplete="one-time-code"]')) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForCodeOrCaptcha(page, requestedAt, email, shouldStop) {
  let stop = false;
  const result = await Promise.race([
    waitForVerificationCode(requestedAt, email, { shouldStop: () => stop || shouldStop?.() }).then((code) => ({ code })),
    (async () => {
      while (!stop && !shouldStop?.()) {
        const text = await pageEvidence(page);
        const kind = pageKind(text);
        if (kind === 'captcha') return { captcha: true };
        if (/problem with your network address|can[’']t sign you in right now/i.test(text)) {
          return { network: true, detail: publicSnippet(text, 420) };
        }
        await page.waitForTimeout(2000);
      }
      return { captcha: false };
    })(),
  ]);
  stop = true;
  return result;
}

async function waitForEmailField(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const field = await findLocator(page, emailSelector);
    if (field) return field;
    await page.waitForTimeout(400);
  }
  return null;
}

function pageWhere(page) {
  try {
    const url = new URL(page.url());
    return `${url.hostname}${url.pathname}`;
  } catch {
    return '';
  }
}

async function signInAs(page, email, onStatus, shouldStop) {
  onStatus(`Opening CVS sign-in for ${email}.`);
  await page.goto('https://www.cvs.com/account-login/look-up', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await dismissOverlays(page);
  let text = await pageEvidence(page);
  if (pageKind(text) === 'captcha') return { ok: false, blocker: 'captcha' };
  let emailField = await waitForEmailField(page);
  if (!emailField) {
    await page.goto('https://www.cvs.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissOverlays(page);
    await clickNamed(page, /sign in/i);
    emailField = await waitForEmailField(page);
  }
  text = await pageEvidence(page);
  if (pageKind(text) === 'captcha') return { ok: false, blocker: 'captcha' };
  if (!emailField) {
    return { ok: false, blocker: 'no-email-field', detail: `${pageWhere(page)} ${publicSnippet(await pageEvidence(page))}`.trim() };
  }
  await emailField.fill(email);
  await clickNamed(page, /^continue$/i);
  const delivery = await waitForDeliveryChoice(page);
  const afterContinue = await pageEvidence(page);
  if (pageKind(afterContinue) === 'captcha') return { ok: false, blocker: 'captcha' };
  if (delivery === 'network' || /problem with your network address|can[’']t sign you in right now/i.test(afterContinue)) {
    return { ok: false, blocker: 'network', detail: publicSnippet(afterContinue, 420) };
  }
  const sent = await sendEmailCode(page);
  if (!sent.ok) return { ok: false, blocker: 'email-delivery', detail: sent.detail };
  onStatus(`Waiting for a new CVS code addressed to ${email}.`);
  const arrived = await waitForCodeOrCaptcha(page, sent.requestedAt, email, shouldStop);
  if (arrived.captcha) return { ok: false, blocker: 'captcha' };
  if (arrived.network) return { ok: false, blocker: 'network', detail: arrived.detail };
  if (!arrived.code) {
    const text = await pageEvidence(page);
    const kind = pageKind(text);
    if (kind === 'captcha') return { ok: false, blocker: 'captcha' };
    if (kind === 'error') return { ok: false, blocker: 'cvs-error', detail: `${pageWhere(page)} ${publicSnippet(text)}`.trim() };
    return { ok: false, blocker: 'no-code', detail: `${pageWhere(page)} ${publicSnippet(text)}`.trim() };
  }
  const fieldReady = await waitForCodeField(page, shouldStop);
  if (!fieldReady) return { ok: false, blocker: 'code-field' };
  onStatus(`Submitting the code sent to ${email}.`);
  if (!(await fillCode(page, arrived.code))) return { ok: false, blocker: 'code-field' };
  await clickNamed(page, /verify|continue|submit|sign in/i);
  await page.waitForTimeout(2500);
  const pathname = pathnameOf(page);
  const after = await pageEvidence(page);
  if (pageKind(after) === 'captcha') return { ok: false, blocker: 'captcha' };
  if (pageKind(after) === 'error') return { ok: false, blocker: 'cvs-error', detail: publicSnippet(after) };
  if (nextAfterCodeAccepted({ pathname, text: after }) === 'wait-for-dob') {
    const handedOff = await waitForDobCompletion(page, email, onStatus, shouldStop);
    if (!handedOff.done) return { ok: false, blocker: handedOff.blocker || 'dob', keepOpen: true };
  }
  const passkey = await declinePasskeyEnrollment(page, onStatus);
  if (!passkey.ok) return { ok: false, blocker: passkey.blocker || 'passkey', keepOpen: true };
  return { ok: true };
}

async function declinePasskeyEnrollment(page, onStatus) {
  const pathname = pathnameOf(page);
  const text = await pageEvidence(page);
  if (!isPasskeyEnrollment({ pathname, text })) return { ok: true };
  onStatus(`CVS offered a passkey. Choosing Not now.`);
  const declined = await clickNamed(page, /^not now$/i);
  if (!declined) return { ok: false, blocker: 'passkey' };
  await page.waitForTimeout(1500);
  const stillThere = isPasskeyEnrollment({ pathname: pathnameOf(page), text: await pageEvidence(page) });
  if (stillThere) return { ok: false, blocker: 'passkey' };
  return { ok: true };
}

async function waitForDobCompletion(page, email, onStatus, shouldStop) {
  onStatus(dobHandoffStatus(email));
  const deadline = Date.now() + Number(process.env.DOB_WAIT_MS || 10 * 60 * 1000);
  while (Date.now() < deadline) {
    if (shouldStop?.()) return { done: false, blocker: 'dob' };
    const pathname = pathnameOf(page);
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
    if (pageKind(text) === 'captcha') return { done: false, blocker: 'captcha' };
    if (pageKind(text) === 'error') return { done: false, blocker: 'cvs-error' };
    if (!isDobChallenge({ pathname, text })) return { done: true };
    await page.waitForTimeout(2000);
  }
  return { done: false, blocker: 'dob' };
}

async function confirmIdentity(page, email, cardLast4) {
  const currentPath = pathnameOf(page);
  const currentText = await pageEvidence(page);
  if (isDobChallenge({ pathname: currentPath, text: currentText })) {
    return { ok: false, blocker: 'dob' };
  }
  const urls = [page.url(), 'https://www.cvs.com/extracare/manage', 'https://www.cvs.com/account/profile', 'https://www.cvs.com/extracare/home'];
  let lastKind = 'other';
  let lastDetail = '';
  for (const url of urls) {
    if (url && url !== page.url()) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await dismissOverlays(page);
    }
    const text = await pageEvidence(page);
    const kind = pageKind(text);
    lastKind = kind;
    lastDetail = publicSnippet(text);
    if (kind === 'captcha') return { ok: false, blocker: 'captcha' };
    if (kind === 'error') return { ok: false, blocker: 'cvs-error', detail: lastDetail };
    const card = shownCard(text);
    if (cardLast4 && card && card !== cardLast4) {
      return { ok: false, blocker: 'wrong-card', detail: `page shows ${card}, coupon is ${cardLast4}` };
    }
    if (kind === 'login') continue;
    if (identityOk(text, email, cardLast4)) return { ok: true, card: card || cardLast4 || null };
  }
  if (lastKind === 'login') return { ok: false, blocker: 'login', detail: lastDetail };
  if (lastKind === 'error') return { ok: false, blocker: 'cvs-error', detail: lastDetail };
  return { ok: false, blocker: 'unverified', detail: lastDetail };
}

async function listPrintActions(page) {
  return page.evaluate(() => {
    const controls = [...document.querySelectorAll('button, a, [role="button"]')];
    return controls.map((control, index) => {
      control.setAttribute('data-print-candidate', String(index));
      let node = control;
      let block = '';
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if (/\$\d/.test(text) && text.length < 700) block = text;
        node = node.parentElement;
      }
      return {
        index,
        name: (control.innerText || control.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        block,
      };
    }).filter((item) => item.name);
  }).catch(() => []);
}

async function readPrintModal(page) {
  return page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
    for (const dialog of dialogs) {
      const heading = dialog.querySelector('h1, h2, [role="heading"]');
      const image = dialog.querySelector('img, [role="img"]');
      const barcodeName = image?.getAttribute('alt') || image?.getAttribute('aria-label') || '';
      if (!/barcode to scan at register/i.test(barcodeName)) continue;
      dialog.setAttribute('data-print-modal', '1');
      return {
        title: (heading?.textContent || '').replace(/\s+/g, ' ').trim(),
        barcodeName: barcodeName.replace(/\s+/g, ' ').trim(),
      };
    }
    return null;
  }).catch(() => null);
}

async function waitForPrintModal(page, offer, pageCard) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const modal = await readPrintModal(page);
    if (modal) {
      const ready = printModalReady({
        title: modal.title,
        barcodeName: modal.barcodeName,
        amount: offer.amount,
        offerCard: offer.cardLast4,
        pageCard,
      });
      if (ready.ok) return ready;
    }
    await page.waitForTimeout(400);
  }
  return { ok: false, reason: 'unverified-image' };
}

async function captureCoupon(page, offer, email, onStatus) {
  if (!couponUrlAllowed(offer.couponUrl)) {
    return { id: offer.id, blocked: true, error: `Did not open ${urlHost(offer.couponUrl) || 'that link'} because it is not a CVS link.` };
  }
  const identity = await confirmIdentity(page, email, offer.cardLast4);
  if (!identity.ok) return { id: offer.id, blocked: true, error: blockerMessage(email, identity) };
  onStatus(`Account ${email}${identity.card ? ` card ${identity.card}` : ''} verified. Opening the coupon.`);
  await page.goto(offer.couponUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  await dismissOverlays(page);
  const text = await pageEvidence(page);
  const kind = pageKind(text);
  const landed = new URL(page.url());
  const where = `${landed.hostname}${landed.pathname}`;
  const card = shownCard(text);
  if (offer.cardLast4 && card && card !== offer.cardLast4) {
    return { id: offer.id, blocked: true, error: blockerMessage(email, { blocker: 'wrong-card', detail: `page shows ${card}, coupon is ${offer.cardLast4}` }) };
  }
  if (kind === 'captcha' || kind === 'error' || kind === 'login') {
    return { id: offer.id, blocked: true, error: blockerMessage(email, { blocker: kind === 'error' ? 'cvs-error' : kind, detail: publicSnippet(text) }) };
  }
  const target = choosePrintTarget(await listPrintActions(page), offer);
  if (!target) {
    return {
      id: offer.id,
      blocked: true,
      error: `Signed in as ${email}${identity.card ? ` (card ${identity.card})` : ''}, but ${where} had no Print preview for this offer. Send to card and redeem were not clicked, and nothing was saved.`,
    };
  }
  onStatus(`Opening the print preview for the $${offer.amount} offer${offer.cardLast4 ? ` on card ${offer.cardLast4}` : ''}.`);
  await page.locator(`[data-print-candidate="${target.index}"]`).click({ timeout: 8000 }).catch(() => {});
  const modal = await waitForPrintModal(page, offer, card || identity.card);
  if (!modal.ok) {
    return { id: offer.id, blocked: true, error: blockerMessage(email, { blocker: 'print' }) };
  }
  const shot = page.locator('[data-print-modal="1"]');
  if (!(await shot.count())) {
    return { id: offer.id, blocked: true, error: blockerMessage(email, { blocker: 'print' }) };
  }
  const buffer = await shot.screenshot({ type: 'png' });
  onStatus(`Saved the print-preview barcode for ${email}.`);
  return {
    id: offer.id,
    mime: 'image/png',
    data: buffer.toString('base64'),
    imageKind: 'code',
  };
}

export async function captureOffers(offers, { onStatus = () => {}, shouldStop } = {}) {
  const saved = [];
  const mailbox = (process.env.GMAIL_USER || '').trim().toLowerCase();
  const domain = mailboxDomain(mailbox);
  for (const group of groupOffers(offers)) {
    if (shouldStop?.()) break;
    if (!group.email) {
      for (const offer of group.offers) {
        saved.push({ id: offer.id, blocked: true, error: 'No CVS account email was found on this message, so it was not opened.' });
      }
      continue;
    }
    if (!otpReadableInMailbox(group.email, mailbox)) {
      for (const offer of group.offers) {
        saved.push({
          id: offer.id,
          blocked: true,
          error: `CVS sends the sign-in code to ${group.email}. That address is outside the ${domain || 'connected'} catch-all, so this mailbox cannot sign in.`,
        });
      }
      continue;
    }
    onStatus(`Starting a separate browser session for ${group.email}.`);
    const context = await launchContext(group.email);
    let keepOpen = false;
    try {
      const page = context.pages()[0] || await context.newPage();
      let signed;
      try {
        signed = await signInAs(page, group.email, onStatus, shouldStop);
      } catch (error) {
        signed = { ok: false, blocker: 'login', detail: publicSnippet(error?.message || error) };
      }
      if (!signed.ok) {
        if (signed.keepOpen) keepOpen = true;
        const error = blockerMessage(group.email, signed);
        for (const offer of group.offers) saved.push({ id: offer.id, blocked: true, error });
        continue;
      }
      for (const offer of group.offers) {
        if (shouldStop?.()) break;
        try {
          saved.push(await captureCoupon(page, offer, group.email, onStatus));
        } catch (error) {
          saved.push({ id: offer.id, blocked: true, error: publicSnippet(error?.message || error) || 'The coupon page could not be opened.' });
        }
      }
    } finally {
      if (!keepOpen) await context.close().catch(() => {});
    }
  }
  return saved;
}
