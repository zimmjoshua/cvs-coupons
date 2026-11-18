import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '../.env') });
dotenv.config({ path: path.join(here, '../../.env') });

const api = (process.env.API_URL || 'http://localhost:5001').replace(/\/$/, '');
const token = process.env.ACCESS_TOKEN || 'dev-coupon-token';

async function call(path, options = {}) {
  const response = await fetch(`${api}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Request failed (${response.status})`);
  return text ? JSON.parse(text) : {};
}

async function main() {
  const pending = await call('/api/capture/pending');
  const offers = pending.offers || [];
  if (!offers.length) {
    console.log('No coupons are waiting for a code.');
    return;
  }
  console.log(`Saving ${offers.length} coupon screen${offers.length === 1 ? '' : 's'}.`);
  const { captureOffers } = await import('./capture.js');
  const saved = await captureOffers(offers, {
    onStatus: (line) => console.log(line),
  });
  for (const item of saved) {
    if (item.error) {
      await call(`/api/coupons/${item.id}/image`, {
        method: 'POST',
        body: JSON.stringify({ error: item.error }),
      });
      console.log(`Could not save ${item.id}: ${item.error}`);
      continue;
    }
    await call(`/api/coupons/${item.id}/image`, {
      method: 'POST',
      body: JSON.stringify({
        imageData: `data:${item.mime};base64,${item.data}`,
        imageKind: item.imageKind,
        barcodeVerified: item.imageKind === 'code' || item.imageKind === 'confirmation',
      }),
    });
    console.log(`Saved ${item.id} (${item.imageKind}).`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
