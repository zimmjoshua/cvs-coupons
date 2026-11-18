export const EMAIL_RADIO_NAME = /^Email(?:\s|$)/i;

export function isEmailRadioName(name) {
  return EMAIL_RADIO_NAME.test(String(name || '').replace(/\s+/g, ' ').trim());
}

export function planEmailDelivery(radios = []) {
  const email = radios.find((radio) => isEmailRadioName(radio?.name));
  if (!email) {
    return { ok: false, reason: 'missing-email-radio', selectEmail: false };
  }
  const textSelected = radios.some((radio) => /^text$/i.test(String(radio?.name || '').trim()) && radio.selected);
  return {
    ok: true,
    selectEmail: true,
    textWasDefault: Boolean(textSelected && !email.selected),
  };
}

export function canSendCode({ emailSelected = false } = {}) {
  return emailSelected === true;
}

export function shouldStartCodePoll({ emailSelected = false, sendClicked = false } = {}) {
  return emailSelected === true && sendClicked === true;
}

export function isDobChallenge({ pathname = '', text = '' } = {}) {
  if (/\/account-login\/verify-user(?:\/|$|\?)/i.test(String(pathname || ''))) return true;
  return /date of birth/i.test(String(text || ''));
}

export function isPasskeyEnrollment({ pathname = '', text = '' } = {}) {
  if (/\/account-login\/passwordless-enrollment(?:\/|$|\?)/i.test(String(pathname || ''))) return true;
  const prompt = String(text || '');
  return /passkey/i.test(prompt) && /not now/i.test(prompt);
}

export function nextAfterCodeAccepted({ pathname = '', text = '' } = {}) {
  if (isDobChallenge({ pathname, text })) return 'wait-for-dob';
  if (isPasskeyEnrollment({ pathname, text })) return 'decline-passkey';
  return 'verify-identity';
}

export function dobHandoffStatus(email) {
  return `CVS is asking for the date of birth for ${email} in the open Chrome window. Enter it there. The coupon stays closed until that check is finished.`;
}
