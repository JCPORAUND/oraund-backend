-- 001_chat_log.sql
-- 모든 채팅 턴을 저장. persona 는 당분간 'unknown' 으로 채워지며,
-- 추후 B2C/B2B 라우터 도입 시 backfill 없이 새 값만 업데이트됨.
--
-- 개인정보 보호 (PIPA):
--   - raw IP 는 저장하지 않음. 대신 SHA256 해시만 저장 (동일인 재방문 식별용).
--   - ip_hash 는 analytics 용도로만 사용. 개인 식별 아님.

CREATE TABLE IF NOT EXISTS chat_log (
  id            BIGSERIAL   PRIMARY KEY,
  session_id    TEXT        NOT NULL,                      -- 브라우저 localStorage 기반 UUID
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  role          TEXT        NOT NULL
                CHECK (role IN ('user', 'assistant', 'system')),
  content       TEXT        NOT NULL,
  persona       TEXT        DEFAULT 'unknown'
                CHECK (persona IN ('b2c', 'b2b', 'unknown')),
  model         TEXT,                                       -- e.g. claude-sonnet-4-20250514
  tokens_in     INT,
  tokens_out    INT,
  flags         JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- dissatisfaction signals
  user_agent    TEXT,
  ip_hash       TEXT                                        -- SHA256(ip + daily_salt), truncated
);

CREATE INDEX IF NOT EXISTS chat_log_session_ts_idx ON chat_log(session_id, ts);
CREATE INDEX IF NOT EXISTS chat_log_ts_idx          ON chat_log(ts DESC);
CREATE INDEX IF NOT EXISTS chat_log_persona_idx     ON chat_log(persona);
CREATE INDEX IF NOT EXISTS chat_log_flags_gin_idx   ON chat_log USING GIN (flags);


-- 상담 요청 (daeryunlaw 방식: 대화 전체를 이메일로 전달)
CREATE TABLE IF NOT EXISTS consultation_request (
  id            BIGSERIAL   PRIMARY KEY,
  session_id    TEXT        NOT NULL,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 리드 정보 (상담 폼 입력)
  name          TEXT,
  phone         TEXT,
  email         TEXT,
  company       TEXT,
  notes         TEXT,

  -- 요청 시점의 전체 대화 스냅샷 [{role,content,ts},…]
  transcript    JSONB       NOT NULL,

  -- 전송 상태
  email_sent    BOOLEAN     NOT NULL DEFAULT false,
  email_sent_ts TIMESTAMPTZ,
  email_error   TEXT
);

CREATE INDEX IF NOT EXISTS consultation_ts_idx      ON consultation_request(ts DESC);
CREATE INDEX IF NOT EXISTS consultation_session_idx ON consultation_request(session_id);


-- 마이그레이션 추적 테이블 (db.js 가 사용)
CREATE TABLE IF NOT EXISTS _migrations (
  name        TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
