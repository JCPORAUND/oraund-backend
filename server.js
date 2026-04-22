// server.js — 엔트리포인트 (라우터 마운트만 담당)
//
// 실제 로직:
//   routes/chat.js    POST /api/chat          — Claude 답변 + DB 로깅 + 불만족 신호
//   routes/consult.js POST /api/consult       — 상담 요청 (대화내용 메일 전송)
//
// 앱 시작 시 db.ready 를 await 해서 마이그레이션이 끝난 뒤 listen.
// DATABASE_URL 이 없으면 DB 는 자동 disabled — 앱은 그대로 동작.

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const db = require('./db');
const chatRouter = require('./routes/chat');
const consultRouter = require('./routes/consult');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// === 라우트 마운트 ===
app.use(chatRouter);
app.use(consultRouter);

// 헬스 체크 — 로드밸런서용. DB 연결도 확인.
app.get('/health', async (req, res) => {
  let dbOk = 'disabled';
  if (!db.DISABLED) {
    try {
      await db.query('SELECT 1');
      dbOk = 'ok';
    } catch (e) {
      dbOk = 'error: ' + e.message;
    }
  }
  res.json({
    status: 'OK',
    message: 'Oraund Chatbot Server is running',
    db: dbOk,
    ts: new Date().toISOString(),
  });
});

// 루트 — API self-doc
app.get('/', (req, res) => {
  res.json({
    message: 'Oraund Chatbot API',
    endpoints: {
      chat:    'POST /api/chat',
      consult: 'POST /api/consult',
      health:  'GET /health',
    },
  });
});


// === 부트 ===
// 마이그레이션이 끝난 뒤 listen. DB 부팅 실패 시 프로세스 종료 → Railway 재시작.
(async () => {
  try {
    await db.ready;
  } catch (err) {
    console.error('[server] DB bootstrap failed — aborting startup');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`🚀 서버가 포트 ${PORT}에서 실행중입니다`);
    console.log(`☕ 오라운트 AI 챗봇 (Powered by Claude) 준비 완료!`);
    console.log(`   DB: ${db.DISABLED ? 'DISABLED (DATABASE_URL missing)' : 'READY'}`);
  });
})();

module.exports = app;
