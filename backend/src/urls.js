const ALLOWED_HOST = [
  /(^|\.)cvs\.com$/i,
  /(^|\.)cvspharmacy\.com$/i,
  /(^|\.)cvs\.health$/i,
  /(^|\.)exacttarget\.com$/i,
  /(^|\.)exct\.net$/i,
  /(^|\.)salesforce\.com$/i,
  /(^|\.)sfmc-content\.com$/i,
  /(^|\.)pardot\.com$/i,
];

export function couponUrlAllowed(raw) {
  let host = '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_HOST.some((pattern) => pattern.test(host));
}

export function urlHost(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}
