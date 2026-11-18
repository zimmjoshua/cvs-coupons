import crypto from 'node:crypto';
import { query } from './db.js';
import { otpReadableInMailbox } from './accountIdentity.js';
import { decodeImage, openCouponUrl } from './imageAttach.js';

export { decodeImage };

const COLUMNS = `
  id, message_id, amount, qualifier, expires_on, expires_label, card_last4,
  subject, from_address, received_at, coupon_url, image_mime, image_kind,
  status, capture_error, used_at, cvs_account_email, created_at, updated_at,
  (image_data IS NOT NULL) AS has_image
`;

export function toPublic(row) {
  return {
    id: row.id,
    amount: row.amount,
    qualifier: row.qualifier,
    expiresOn: row.expires_on,
    expiresLabel: row.expires_label,
    cardLast4: row.card_last4,
    cvsAccountEmail: row.cvs_account_email,
    subject: row.subject,
    from: row.from_address,
    receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
    status: row.status,
    hasImage: Boolean(row.has_image),
    imageKind: row.image_kind,
    couponUrl: openCouponUrl(row.coupon_url),
    otpReadable: otpReadableInMailbox(row.cvs_account_email, process.env.GMAIL_USER || ''),
    captureError: row.capture_error,
    usedAt: row.used_at ? new Date(row.used_at).toISOString() : null,
  };
}

export async function listCoupons() {
  const result = await query(`SELECT ${COLUMNS} FROM coupons ORDER BY expires_on NULLS LAST, amount DESC`);
  return result.rows.map(toPublic);
}

export async function getCoupon(id) {
  const result = await query(`SELECT ${COLUMNS} FROM coupons WHERE id = $1`, [id]);
  return result.rows[0] ? toPublic(result.rows[0]) : null;
}

export async function getImage(id) {
  const result = await query('SELECT image_data, image_mime FROM coupons WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row?.image_data) return null;
  return {
    mime: row.image_mime || 'image/png',
    buffer: Buffer.from(row.image_data, 'base64'),
  };
}

export async function upsertOffer(offer) {
  const existing = await query('SELECT id, status FROM coupons WHERE id = $1', [offer.id]);
  if (!existing.rows.length) {
    await query(
      `INSERT INTO coupons (
        id, message_id, amount, qualifier, expires_on, expires_label, card_last4,
        subject, from_address, received_at, coupon_url, cvs_account_email
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        offer.id,
        offer.messageId,
        offer.amount,
        offer.qualifier,
        offer.expiresOn,
        offer.expiresLabel,
        offer.cardLast4,
        offer.subject,
        offer.from,
        offer.receivedAt,
        offer.couponUrl,
        offer.cvsAccountEmail || null,
      ],
    );
    return 'imported';
  }

  await query(
    `UPDATE coupons SET
      qualifier = COALESCE($2, qualifier),
      expires_on = COALESCE($3, expires_on),
      expires_label = COALESCE($4, expires_label),
      card_last4 = COALESCE($5, card_last4),
      coupon_url = COALESCE($6, coupon_url),
      cvs_account_email = COALESCE($7, cvs_account_email),
      updated_at = NOW()
     WHERE id = $1`,
    [offer.id, offer.qualifier, offer.expiresOn, offer.expiresLabel, offer.cardLast4, offer.couponUrl, offer.cvsAccountEmail || null],
  );
  return existing.rows[0].status === 'used' ? 'used' : 'already';
}

export async function confirmBarcode(id) {
  const existing = await query('SELECT image_data IS NOT NULL AS has_image FROM coupons WHERE id = $1', [id]);
  if (!existing.rows[0]?.has_image) return null;
  await query(`UPDATE coupons SET image_kind = 'code', updated_at = NOW() WHERE id = $1`, [id]);
  return getCoupon(id);
}

export async function saveImage(id, { data, mime, imageKind }) {
  const result = await query(
    `UPDATE coupons
     SET image_data = $2, image_mime = $3, image_kind = $4, capture_error = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id, data, mime, imageKind || 'attached'],
  );
  return result.rowCount > 0;
}

export async function saveCaptureError(id, message) {
  const result = await query(
    'UPDATE coupons SET capture_error = $2, updated_at = NOW() WHERE id = $1',
    [id, String(message || 'Could not save the coupon screen.').slice(0, 180)],
  );
  return result.rowCount > 0;
}

export async function setStatus(id, status) {
  const usedAt = status === 'used' ? new Date().toISOString() : null;
  const result = await query(
    'UPDATE coupons SET status = $2, used_at = $3, updated_at = NOW() WHERE id = $1',
    [id, status, usedAt],
  );
  return result.rowCount > 0;
}

export async function removeCoupon(id) {
  const result = await query('DELETE FROM coupons WHERE id = $1', [id]);
  return result.rowCount > 0;
}

export async function createManual({ amount, expiresOn, image }) {
  const id = `m${crypto.randomBytes(8).toString('hex')}`;
  await query(
    `INSERT INTO coupons (id, amount, qualifier, expires_on, image_data, image_mime, image_kind, subject)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Added on this phone')`,
    [
      id,
      amount,
      'off your purchase',
      expiresOn || null,
      image?.data || null,
      image?.mime || null,
      image ? 'attached' : null,
    ],
  );
  return getCoupon(id);
}

export async function pendingCapture(limit = 20) {
  const result = await query(
    `SELECT id, coupon_url, cvs_account_email, card_last4 FROM coupons
     WHERE image_data IS NULL
       AND coupon_url IS NOT NULL
       AND status = 'available'
       AND (expires_on IS NULL OR expires_on >= CURRENT_DATE)
     ORDER BY expires_on NULLS LAST
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    couponUrl: row.coupon_url,
    cvsAccountEmail: row.cvs_account_email,
    cardLast4: row.card_last4,
  }));
}

export async function setMeta(key, value) {
  await query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export async function getMeta(key) {
  const result = await query('SELECT value FROM meta WHERE key = $1', [key]);
  return result.rows[0]?.value || null;
}
