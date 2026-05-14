-- 002_cafe24_token.sql
-- Cafe24 Admin OAuth token storage (single-row per mall).
-- access_token expires every 2 hours, refresh_token every 14 days.
-- The lib/cafe24-client.js auto-refreshes when access_token is within 5 min of expiry.

CREATE TABLE IF NOT EXISTS cafe24_token (
  mall_id              TEXT        PRIMARY KEY,
  access_token         TEXT        NOT NULL,
  refresh_token        TEXT        NOT NULL,
  scope                TEXT,
  expires_at           TIMESTAMPTZ NOT NULL,    -- access_token expiry
  refresh_expires_at   TIMESTAMPTZ NOT NULL,    -- refresh_token expiry (~14 days)
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cache of customer order summaries for AI recommendations.
-- We store a denormalised summary so AI prompts stay small + chat is fast.
CREATE TABLE IF NOT EXISTS cafe24_order_summary (
  member_id        TEXT        PRIMARY KEY,
  summary          JSONB       NOT NULL,        -- {beans:[{id,qty,last_ordered}], blend_style:'고소'|'산뜻'|...}
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cafe24_order_summary_fetched_idx ON cafe24_order_summary(fetched_at DESC);
