import { Router } from 'express';

const SESSION_ID = /^[a-f0-9]{32}$/;

function send(res, result) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
  if (result.status === 204) return res.status(204).end();
  return res.status(result.status).json(result.body);
}

export function verificationRouter({ hub, getCoupon }) {
  const router = Router();

  router.post('/coupons/:id/verification', async (req, res, next) => {
    try {
      const coupon = await getCoupon(req.params.id);
      return send(res, hub.start({ coupon }));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/coupons/:id/verification/:sessionId', async (req, res, next) => {
    try {
      if (!SESSION_ID.test(req.params.sessionId)) {
        return send(res, { status: 404, body: { error: 'That code check has ended.' } });
      }
      return send(res, await hub.poll({ couponId: req.params.id, sessionId: req.params.sessionId }));
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/coupons/:id/verification/:sessionId', (req, res, next) => {
    try {
      if (!SESSION_ID.test(req.params.sessionId)) {
        return send(res, { status: 404, body: { error: 'That code check has ended.' } });
      }
      return send(res, hub.cancel({ couponId: req.params.id, sessionId: req.params.sessionId }));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
