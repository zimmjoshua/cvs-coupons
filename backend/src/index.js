import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { requireBearer } from './access.js';
import { migrate, pool } from './db.js';
import { gmailConfigured, readLabelVerificationCode, syncConnectedMailbox } from './gmail.js';
import { withSyncLock } from './syncLock.js';
import { normalizeSyncState, publicSyncStatus, startSyncLoop } from './syncOffers.js';
import { createVerificationHub } from './verificationSession.js';
import { verificationRouter } from './verificationRoutes.js';
import { couponUrlAllowed } from './urls.js';
import { prepareAttachment } from './imageAttach.js';
import {
  createManual,
  decodeImage,
  confirmBarcode,
  getCoupon,
  getImage,
  getMeta,
  listCoupons,
  pendingCapture,
  removeCoupon,
  saveCaptureError,
  saveImage,
  setMeta,
  setStatus,
  upsertOffer,
} from './couponStore.js';

const DEV_TOKEN = 'dev-coupon-token';
const token = process.env.ACCESS_TOKEN || (process.env.NODE_ENV === 'production' ? '' : DEV_TOKEN);

if (process.env.NODE_ENV === 'production' && (!token || token === DEV_TOKEN)) {
  console.error('Refusing to start in production without a unique ACCESS_TOKEN.');
  process.exit(1);
}

const app = express();
const port = Number(process.env.PORT || 5000);
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : ['http://localhost:3000'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '12mb' }));

app.param('id', (req, res, next, id) => {
  if (!/^[a-f0-9]{20}$/.test(id) && !/^m[a-f0-9]{16}$/.test(id)) {
    return res.status(404).json({ error: 'Coupon not found.' });
  }
  next();
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    const sync = await syncPayload();
    const degraded = Boolean(sync.needsReauthentication || sync.label?.found === false || sync.lastError);
    res.json({
      status: degraded ? 'degraded' : 'ok',
      database: 'ok',
      sync,
    });
  } catch {
    res.status(503).json({ status: 'error', database: 'error' });
  }
});

const requireToken = requireBearer(() => token);
const verificationHub = createVerificationHub({
  mailbox: () => process.env.GMAIL_USER || '',
  readCode: (query) => readLabelVerificationCode(query),
});

app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  return requireToken(req, res, next);
});

app.post('/api/session', (_req, res) => {
  res.json({ ok: true });
});

function syncIntervalMs() {
  const value = Number(process.env.SYNC_INTERVAL_MS);
  if (!Number.isFinite(value) || value < 15000) return 60000;
  return value;
}

async function loadSyncState() {
  const raw = await getMeta('sync_state');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveSyncState(state) {
  const stored = normalizeSyncState(state);
  await setMeta('sync_state', JSON.stringify(stored));
  if (stored.lastSuccess) await setMeta('last_scan', stored.lastSuccess);
  return stored;
}

async function syncPayload() {
  return publicSyncStatus(await loadSyncState());
}

let syncing = false;

async function runSync({ interactive }) {
  if (syncing) {
    const current = normalizeSyncState(await loadSyncState());
    return { ...current, skipped: 'overlap' };
  }
  return withSyncLock(pool, async () => {
    syncing = true;
    try {
      const next = await syncConnectedMailbox(await loadSyncState(), {
        interactive,
        intervalMs: syncIntervalMs(),
        upsert: upsertOffer,
      });
      await saveSyncState(next);
      const error = next.lastError ? ` error: ${next.lastError}` : '';
      const label = next.label?.found ? ` label ${next.label.name}` : '';
      console.log(`Mailbox check imported ${next.imported || 0}, already ${next.already || 0}, next ${next.nextPoll || 'unscheduled'}.${label}${error}`);
      return next;
    } finally {
      syncing = false;
    }
  });
}

app.get('/api/info', async (_req, res, next) => {
  try {
    const sync = await syncPayload();
    res.json({
      gmail: gmailConfigured(),
      lastScan: sync.lastSuccess,
      sync,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/coupons', async (_req, res, next) => {
  try {
    const sync = await syncPayload();
    res.json({ coupons: await listCoupons(), lastScan: sync.lastSuccess, sync });
  } catch (error) {
    next(error);
  }
});

app.post('/api/coupons', async (req, res, next) => {
  try {
    const amount = Number(req.body?.amount);
    if (amount !== 2 && amount !== 4) {
      return res.status(400).json({ error: 'Amount has to be $2 or $4.' });
    }
    const image = req.body?.imageData ? decodeImage(req.body.imageData) : null;
    if (req.body?.imageData && !image) {
      return res.status(400).json({ error: 'Use a PNG or JPEG of the coupon screen.' });
    }
    const coupon = await createManual({
      amount,
      expiresOn: req.body?.expiresOn || null,
      image,
    });
    res.status(201).json({ coupon });
  } catch (error) {
    next(error);
  }
});

app.get('/api/coupons/:id/image', async (req, res, next) => {
  try {
    const image = await getImage(req.params.id);
    if (!image) return res.status(404).json({ error: 'No coupon screen saved yet.' });
    res.set('Content-Type', image.mime);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(image.buffer);
  } catch (error) {
    next(error);
  }
});

app.post('/api/coupons/:id/image', async (req, res, next) => {
  try {
    if (req.body?.confirmBarcode && !req.body?.imageData) {
      const coupon = await confirmBarcode(req.params.id);
      if (!coupon) return res.status(400).json({ error: 'Attach the print preview before confirming the barcode.' });
      return res.json({ coupon });
    }
    if (req.body?.error && !req.body?.imageData) {
      const saved = await saveCaptureError(req.params.id, req.body.error);
      if (!saved) return res.status(404).json({ error: 'Coupon not found.' });
      return res.json({ coupon: await getCoupon(req.params.id) });
    }
    const image = prepareAttachment(req.body || {});
    if (image.error) return res.status(400).json({ error: image.error });
    const saved = await saveImage(req.params.id, image);
    if (!saved) return res.status(404).json({ error: 'Coupon not found.' });
    res.json({ coupon: await getCoupon(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/coupons/:id/use', async (req, res, next) => {
  try {
    const saved = await setStatus(req.params.id, 'used');
    if (!saved) return res.status(404).json({ error: 'Coupon not found.' });
    res.json({ coupon: await getCoupon(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/coupons/:id/restore', async (req, res, next) => {
  try {
    const saved = await setStatus(req.params.id, 'available');
    if (!saved) return res.status(404).json({ error: 'Coupon not found.' });
    res.json({ coupon: await getCoupon(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/coupons/:id', async (req, res, next) => {
  try {
    const removed = await removeCoupon(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Coupon not found.' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/capture/pending', async (_req, res, next) => {
  try {
    const offers = (await pendingCapture()).filter((offer) => couponUrlAllowed(offer.couponUrl));
    res.json({ offers });
  } catch (error) {
    next(error);
  }
});

app.post('/api/scan', async (_req, res, next) => {
  try {
    const nextState = await runSync({ interactive: process.env.NODE_ENV !== 'production' });
    const sync = publicSyncStatus(nextState);
    if (nextState.skipped === 'overlap') {
      return res.json({ found: 0, imported: 0, already: 0, skipped: 'overlap', sync });
    }
    if (nextState.lastError) return res.status(400).json({ error: nextState.lastError, sync });
    res.json({
      found: (nextState.imported || 0) + (nextState.already || 0) + (nextState.skippedExpired || 0),
      imported: nextState.imported || 0,
      already: nextState.already || 0,
      skippedExpired: nextState.skippedExpired || 0,
      lastScan: nextState.lastSuccess,
      sync,
    });
  } catch (error) {
    const message = error.message || '';
    if (message.startsWith('Gmail') || message.startsWith('Could not read Gmail')) {
      return res.status(400).json({ error: message });
    }
    next(error);
  }
});

app.use('/api', verificationRouter({ hub: verificationHub, getCoupon }));

const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong.' });
});

let server = null;
let loop = null;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const pending = loop?.stop?.() || Promise.resolve();
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 8000))]);
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown().catch(() => process.exit(1));
});
process.on('SIGINT', () => {
  shutdown().catch(() => process.exit(1));
});

async function start() {
  await pool.query('SELECT 1');
  await migrate();
  server = app.listen(port, () => {
    console.log(`Coupons API running on port ${port}`);
  });
  loop = startSyncLoop({
    loadState: loadSyncState,
    saveState: saveSyncState,
    runOnce: () => runSync({ interactive: false }),
  });
}

start().catch((error) => {
  console.error('Unable to start server:', error);
  process.exit(1);
});
