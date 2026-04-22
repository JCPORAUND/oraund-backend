// db.js — Postgres pool + 앱 시작 시 자동 마이그레이션
//
// 사용법:
//   const db = require('./db');
//   await db.ready;                         // 마이그레이션 완료 대기
//   await db.query('SELECT ...', [args]);
//
// 환경변수:
//   DATABASE_URL (Railway Postgres 가 자동 주입)
//
// DATABASE_URL 이 없으면: 조용히 disabled 모드로 진입 (로컬 개발 편의).
// query() 호출 시 warning 만 찍고 undefined 반환 — 앱은 계속 동작.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const DISABLED = !DATABASE_URL;

let pool = null;
if (!DISABLED) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Railway 내부 네트워크는 TLS 불필요, 외부는 필요.
    ssl: /railway\.internal/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 5,                 // 채팅 로깅용으론 충분
    idleTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    console.error('[db] unexpected pool error:', err.message);
  });
}

async function query(text, params) {
  if (DISABLED) {
    if (!query._warned) {
      console.warn('[db] DATABASE_URL not set — query() is a no-op in this environment');
      query._warned = true;
    }
    return { rows: [], rowCount: 0 };
  }
  return pool.query(text, params);
}

async function runMigrations() {
  if (DISABLED) {
    console.warn('[db] DATABASE_URL not set — skipping migrations');
    return;
  }
  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir)) return;

  // _migrations 테이블은 모든 SQL 파일에 포함되어 있다고 가정할 수 없으므로
  // 여기서 한 번 더 ensure.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM _migrations WHERE name = $1', [file]
    );
    if (rows.length) {
      console.log(`[db] migration ${file} already applied`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations(name) VALUES ($1)', [file]
      );
      await client.query('COMMIT');
      console.log(`[db] applied migration ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[db] migration ${file} FAILED:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

// 앱 시작 시 한 번만 실행. 실패하면 앱이 죽음 (의도적 — DB 깨진 상태로 서빙 금지).
const ready = (async () => {
  if (DISABLED) return;
  try {
    await runMigrations();
    console.log('[db] ready');
  } catch (err) {
    console.error('[db] migration bootstrap failed:', err);
    // Railway 에서 재배포 시 자동 재시도되므로 throw 가 안전.
    throw err;
  }
})();

module.exports = { pool, query, ready, DISABLED };
