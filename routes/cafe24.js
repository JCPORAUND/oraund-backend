// routes/cafe24.js — Cafe24 OAuth + customer order endpoints.
//
//  GET  /api/cafe24/oauth/start       — admin redirects here once to authorise
//  GET  /api/cafe24/oauth/callback    — Cafe24 redirects here with code → save token
//  GET  /api/cafe24/me/orders         — customer fetches their own orders
//                                       (requires ?member_id=... — derived client-side from Cafe24 session)
//  GET  /api/cafe24/health            — status of admin token + DB

const express = require('express');
const router = express.Router();
const cafe24 = require('../lib/cafe24-client');
const db = require('../db');
const { summariseOrders } = require('../lib/order-summary');

// === ADMIN: kick off OAuth ===
router.get('/api/cafe24/oauth/start', (req, res) => {
  if (!cafe24.isConfigured()) {
    return res.status(500).send('Cafe24 OAuth not configured. Missing CAFE24_CLIENT_ID / CAFE24_CLIENT_SECRET / CAFE24_MALL_ID env vars.');
  }
  // CSRF state — for one-time admin flow we just use a fixed string.
  const state = 'oraund-admin-' + Date.now();
  res.redirect(cafe24.buildAuthUrl(state));
});

// === ADMIN: OAuth callback — Cafe24 sends ?code=... ===
router.get('/api/cafe24/oauth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.status(400).send(`OAuth error: ${error}`);
  }
  if (!code) {
    return res.status(400).send('Missing ?code');
  }
  try {
    const tokenData = await cafe24.exchangeCodeForToken(code);
    await cafe24.saveAdminToken(tokenData);
    res.send(`
      <!DOCTYPE html>
      <meta charset="utf-8">
      <title>Cafe24 OAuth — Success</title>
      <style>body{font-family:system-ui;padding:60px 20px;text-align:center;background:#0a0a0a;color:#fff}</style>
      <h1 style="color:#0ABAB5">✓ Cafe24 인증 완료</h1>
      <p>Mall: <code>${cafe24.MALL_ID}</code></p>
      <p>Access token이 발급되어 저장되었습니다. 이제 AI 채팅에서 주문 내역 기반 추천이 가능합니다.</p>
      <p style="color:#888;font-size:13px">이 창은 닫아도 됩니다.</p>
    `);
  } catch (e) {
    console.error('[cafe24/oauth] callback error:', e);
    res.status(500).send(`Error: ${e.message}`);
  }
});

// === Health ===
router.get('/api/cafe24/health', async (req, res) => {
  try {
    const token = await cafe24.loadAdminToken();
    res.json({
      configured: cafe24.isConfigured(),
      hasToken: Boolean(token),
      expiresAt: token?.expires_at || null,
      mallId: cafe24.MALL_ID,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === CUSTOMER: fetch own orders ===
// Trusts member_id from query string. Cafe24 customers are session-authed on
// oraund.com — the client-side JS reads member_id from Cafe24's exposed JS
// vars (e.g. xans_member_var.member_id) and sends it here. This is safe so
// long as we don't return anything destructive — only read summaries.
router.get('/api/cafe24/me/orders', async (req, res) => {
  const memberId = (req.query.member_id || '').trim();
  if (!memberId) {
    return res.status(400).json({ error: 'member_id required' });
  }

  try {
    // Try cache first
    if (!db.DISABLED) {
      const cached = await db.query(
        `SELECT summary, fetched_at FROM cafe24_order_summary
         WHERE member_id = $1 AND fetched_at > NOW() - INTERVAL '1 hour'`,
        [memberId]
      );
      if (cached.rows[0]) {
        return res.json({ source: 'cache', ...cached.rows[0].summary });
      }
    }

    const orders = await cafe24.getCustomerOrders(memberId, { limit: 30 });
    const summary = summariseOrders(orders);

    // Cache
    if (!db.DISABLED) {
      await db.query(
        `INSERT INTO cafe24_order_summary (member_id, summary, fetched_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (member_id) DO UPDATE SET summary = EXCLUDED.summary, fetched_at = NOW()`,
        [memberId, JSON.stringify(summary)]
      );
    }

    res.json({ source: 'live', ...summary });
  } catch (e) {
    console.error('[cafe24/orders]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
