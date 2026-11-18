export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CVS_LABEL_NAME = 'CVS';

export function labelName() {
  return (process.env.GMAIL_LABEL || CVS_LABEL_NAME).trim() || CVS_LABEL_NAME;
}

export function missingLabelError(name = labelName()) {
  const error = new Error(`Gmail label ${name} was not found. Create that label in Gmail. This check only reads it and does not create labels or change mail.`);
  error.code = 'label_missing';
  error.labelName = name;
  return error;
}

export function couponListParams({ labelId, pageToken, maxResults, label = labelName() } = {}) {
  if (!labelId) throw missingLabelError(label);
  const params = { labelIds: [String(labelId)], maxResults: String(maxResults || 5) };
  if (pageToken) params.pageToken = pageToken;
  return params;
}

export function couponHistoryParams({ labelId, startHistoryId, pageToken, maxResults, label = labelName() } = {}) {
  if (!labelId) throw missingLabelError(label);
  const params = {
    startHistoryId: String(startHistoryId),
    labelId: String(labelId),
    maxResults: String(maxResults || 5),
    historyTypes: ['messageAdded', 'labelAdded'],
  };
  if (pageToken) params.pageToken = pageToken;
  return params;
}

export function verificationQuery(afterMs) {
  const seconds = Number.isFinite(Number(afterMs))
    ? Math.floor(Number(afterMs) / 1000) - 1
    : Math.floor(Date.now() / 1000) - 1;
  return `from:info@alerts.cvs.com subject:"verification code" after:${seconds}`;
}

export function verificationListParams({ labelId, pageToken, maxResults = 15, afterMs, label = labelName() } = {}) {
  if (!labelId) throw missingLabelError(label);
  const params = {
    labelIds: [String(labelId)],
    maxResults: String(maxResults),
    q: verificationQuery(afterMs),
  };
  if (pageToken) params.pageToken = pageToken;
  return params;
}

export function findLabel(labels, name = labelName()) {
  return (labels || []).find((label) => label?.name === name) || null;
}
