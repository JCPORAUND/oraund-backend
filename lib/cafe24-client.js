// lib/cafe24-client.js — Cafe24 Admin API client
//
// Implements OAuth 2.0 (authorization code grant + refresh token) and
// helpers for fetching customer orders. Tokens are stored in cafe24_token
// table and auto-refreshed when expired.
//
// Env vars required:
//   CAFE24_CLIENT_ID
//   CAFE24_CLIENT_SECRET
//   CAFE24_MALL_ID         e.g. "jcpinter"
//
// One-time admin OAuth: visit /api/cafe24/oauth/start in a browser as the
// shop owner. After consent, Cafe24 redirects to /api/cafe24/oauth/callback
// which stores the tokens.

const db = require('../db');

const CLIENT_ID     = process.env.CAFE24_CLIENT_ID;
const CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const MALL_ID       = process.env.CAFE24_MALL_ID || 'jcpinter';
const REDIRECT_URI  = (process.env.BASE_URL || 'https://oraund-backend-production.up.railway.app') + '/api/cafe24/oauth/callback';

// Scopes we ask for (admin-side).
// mall.read_order — read all orders (filter by member_id client-side)
// mall.read_personal — read personal info (member_id, email, etc.)
const SCOPES = ['mall.read_order', 'mall.read_personal', 'mall.read_customer'].join(',');

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && MALL_ID);
}

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    state: state || 'init',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });
  return `https://${MALL_ID}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const url = `https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Cafe24 token exchange failed: ${r.status} ${errText}`);
  }
  return await r.json();
}

async function refreshAccessToken(refreshToken) {
  const url = `https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Cafe24 token refresh failed: ${r.status} ${errText}`);
  }
  return await r.json();
}

// Persist the admin token in DB (single-row table, mall_id = primary key).
async function saveAdminToken(tokenData) {
  if (db.DISABLED) throw new Error('DB not configured');
  const expiresAt = new Date(Date.now() + (tokenData.expires_in || 7200) * 1000);
  const refreshExpiresAt = new Date(Date.now() + (tokenData.refresh_token_expires_in || 60 * 60 * 24 * 14) * 1000);
  await db.query(
    `INSERT INTO cafe24_token (mall_id, access_token, refresh_token, scope, expires_at, refresh_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (mall_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       scope = EXCLUDED.scope,
       expires_at = EXCLUDED.expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       updated_at = NOW()`,
    [MALL_ID, tokenData.access_token, tokenData.refresh_token, tokenData.scopes?.join(',') || SCOPES, expiresAt, refreshExpiresAt]
  );
}

async function loadAdminToken() {
  if (db.DISABLED) return null;
  const r = await db.query(
    `SELECT access_token, refresh_token, expires_at FROM cafe24_token WHERE mall_id = $1`,
    [MALL_ID]
  );
  return r.rows[0] || null;
}

// Get a valid access_token, refreshing if needed.
async function getAccessToken() {
  const row = await loadAdminToken();
  if (!row) throw new Error('Admin OAuth not completed. Visit /api/cafe24/oauth/start as shop owner.');
  const now = Date.now();
  const exp = new Date(row.expires_at).getTime();
  // refresh 5 min before expiry to be safe
  if (exp - now > 5 * 60 * 1000) {
    return row.access_token;
  }
  // refresh
  const fresh = await refreshAccessToken(row.refresh_token);
  await saveAdminToken(fresh);
  return fresh.access_token;
}

// === API calls ===

async function apiGet(path, params = {}) {
  const token = await getAccessToken();
  const qs = new URLSearchParams(params).toString();
  const url = `https://${MALL_ID}.cafe24api.com/api/v2/admin${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Cafe24-Api-Version': '2024-09-01',
    },
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Cafe24 API ${path} failed: ${r.status} ${errText}`);
  }
  return await r.json();
}

// Fetch orders for a specific customer (by member_id).
// Returns array of {order_id, ordered_at, items: [{product_no, product_name, item_code, quantity, price}]}
async function getCustomerOrders(memberId, opts = {}) {
  const limit = opts.limit || 30;
  const startDate = opts.startDate; // YYYY-MM-DD
  const params = {
    member_id: memberId,
    limit,
    embed: 'items',
  };
  if (startDate) params.start_date = startDate;

  const data = await apiGet('/orders', params);
  const orders = (data.orders || []).map(o => ({
    order_id: o.order_id,
    ordered_at: o.order_date,
    status: o.order_place_name,
    items: (o.items || []).map(it => ({
      product_no: it.product_no,
      product_name: it.product_name,
      variant_code: it.variant_code,
      quantity: it.quantity,
      price: it.product_price,
      option_value: it.option_value,
    })),
  }));
  return orders;
}

// Fetch customer info (member_id, email, name).
async function getCustomer(memberId) {
  const data = await apiGet(`/customers/${memberId}`);
  return data.customer || null;
}

module.exports = {
  isConfigured,
  buildAuthUrl,
  exchangeCodeForToken,
  saveAdminToken,
  loadAdminToken,
  getAccessToken,
  getCustomerOrders,
  getCustomer,
  MALL_ID,
};
