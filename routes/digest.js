// routes/digest.js — 다이제스트 수동 트리거 (테스트 / 과거일 재발송용)
//
// GET  /internal/digest?date=YYYY-MM-DD&secret=XXXX&preview=1
//   - preview=1 : 이메일 발송 없이 JSON 으로 결과 반환
//   - preview 생략 : 실제로 메일 발송
//
// 환경변수:
//   DIGEST_SECRET — 엔드포인트 호출용 공유 시크릿. 설정 안 하면 라우트 자체가 비활성화.
//
// 왜 /internal prefix 를 쓰는지:
//   - /api/* 는 프론트에서 호출하는 공개 엔드포인트. digest 는 관리자/자동화용이라 네임스페이스 분리.
//   - 프론트 CORS 와 섞이지 않게 함.

const express = require('express');
const { buildDigest, sendDigest, yesterdayKstISO } = require('../lib/digest');

const router = express.Router();

const SECRET = process.env.DIGEST_SECRET;

function requireSecret(req, res, next) {
  if (!SECRET) {
    return res.status(503).json({
      error: 'DIGEST_SECRET env var not configured — manual digest endpoint disabled',
    });
  }
  const provided = req.query.secret || req.get('x-digest-secret');
  if (provided !== SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// 미리보기 — DB 집계만 하고 메일 안 보냄
router.get('/internal/digest', requireSecret, async (req, res) => {
  const date = req.query.date || yesterdayKstISO();
  const preview = req.query.preview === '1' || req.query.preview === 'true';

  try {
    if (preview) {
      const digest = await buildDigest(date);
      return res.json({
        ok: true,
        mode: 'preview',
        date,
        subject: digest.subject,
        stats: digest.stats,
        html: digest.htmlBody,
        text: digest.textBody,
      });
    }
    const result = await sendDigest(date);
    return res.json(result);
  } catch (err) {
    console.error('[digest] manual trigger failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
