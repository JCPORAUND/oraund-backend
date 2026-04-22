// routes/consult.js — POST /api/consult
//
// daeryunlaw.com 의 "위 대화 내용으로 상담 요청하기" 기능 이식.
//
// Flow:
//   1. 프론트에서 {sessionId, name, phone, email, company, notes, transcript} 로 POST
//   2. consultation_request 테이블에 저장 (DB 없어도 동작 — 로그로만 남김)
//   3. nodemailer 로 info@oraund.com + bywockd@gmail.com 에 메일 발송
//      SMTP_* 환경변수가 없으면 console 에 찍고 email_sent=false 로 저장
//
// 환경변수 (선택):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//   CONSULT_TO (기본: info@oraund.com,bywockd@gmail.com)

const express = require('express');
const nodemailer = require('nodemailer');

const db = require('../db');

const router = express.Router();

const CONSULT_TO = (process.env.CONSULT_TO || 'info@oraund.com,bywockd@gmail.com')
  .split(',').map(s => s.trim()).filter(Boolean);

// SMTP 설정이 있는지 체크. 하나라도 없으면 dry-run 모드.
const SMTP_CONFIGURED = !!(
  process.env.SMTP_HOST && process.env.SMTP_PORT &&
  process.env.SMTP_USER && process.env.SMTP_PASS
);

let transporter = null;
if (SMTP_CONFIGURED) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: parseInt(process.env.SMTP_PORT, 10) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log('[consult] SMTP transporter ready');
} else {
  console.warn('[consult] SMTP_* env vars missing — email sending is DISABLED (logs only)');
}


function renderTranscriptPlain(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return '(대화 없음)';
  return transcript.map((m, i) => {
    const who = m.role === 'user' ? '👤 고객' : '🤖 AI';
    return `[${i + 1}] ${who}\n${m.content}\n`;
  }).join('\n---\n\n');
}

function renderTranscriptHtml(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return '<p>(대화 없음)</p>';
  return transcript.map((m, i) => {
    const who = m.role === 'user'
      ? '<b style="color:#6b4e3a">고객</b>'
      : '<b style="color:#2a7d2a">AI</b>';
    const safe = String(m.content || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    return `<div style="margin:12px 0;padding:12px;background:${i%2?'#f7f5f0':'#fff'};border-left:3px solid ${m.role==='user'?'#6b4e3a':'#2a7d2a'}">
      <div style="font-size:12px;opacity:0.6;margin-bottom:4px">#${i+1} ${who}</div>
      <div>${safe}</div>
    </div>`;
  }).join('');
}


router.post('/api/consult', async (req, res) => {
  const {
    sessionId, name, phone, email, company, notes,
    transcript,  // [{role,content,ts}, ...]
  } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId 가 필요합니다.' });
  }
  if (!Array.isArray(transcript) || !transcript.length) {
    return res.status(400).json({ error: 'transcript 가 비어있습니다.' });
  }
  if (!phone && !email) {
    return res.status(400).json({ error: '연락처(전화 또는 이메일) 중 하나는 필수입니다.' });
  }

  // 1) DB 기록 (실패해도 이메일은 계속 시도)
  let requestId = null;
  if (!db.DISABLED) {
    try {
      const { rows } = await db.query(
        `INSERT INTO consultation_request
          (session_id, name, phone, email, company, notes, transcript)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [sessionId, name || null, phone || null, email || null,
         company || null, notes || null, JSON.stringify(transcript)]
      );
      requestId = rows[0]?.id;
    } catch (err) {
      console.error('[consult] failed to insert request:', err.message);
    }
  }

  // 2) 이메일 구성
  const subject = `[ORAUND 상담 요청] ${company || name || '미기입'} — session ${sessionId.slice(0, 8)}`;
  const plainBody = [
    '=== 오라운트 AI 상담 요청 ===',
    `요청시간: ${new Date().toISOString()}`,
    `세션ID : ${sessionId}`,
    `상담ID : ${requestId ?? '(DB 미저장)'}`,
    '',
    '--- 리드 정보 ---',
    `회사명 : ${company || '-'}`,
    `성함   : ${name || '-'}`,
    `연락처 : ${phone || '-'}`,
    `이메일 : ${email || '-'}`,
    `메모   : ${notes || '-'}`,
    '',
    '--- 대화 내용 ---',
    renderTranscriptPlain(transcript),
  ].join('\n');

  const htmlBody = `
    <div style="font-family:-apple-system,'Helvetica Neue',sans-serif;max-width:680px;margin:auto;color:#333">
      <h2 style="color:#6b4e3a;border-bottom:2px solid #6b4e3a;padding-bottom:8px">
        ☕ 오라운트 AI 상담 요청
      </h2>
      <table style="width:100%;font-size:14px;margin:16px 0">
        <tr><td style="padding:4px 8px;opacity:0.6;width:90px">요청시간</td><td>${new Date().toLocaleString('ko-KR')}</td></tr>
        <tr><td style="padding:4px 8px;opacity:0.6">세션ID</td><td><code>${sessionId}</code></td></tr>
        <tr><td style="padding:4px 8px;opacity:0.6">상담ID</td><td>${requestId ?? '<i>(DB 미저장)</i>'}</td></tr>
        <tr><td style="padding:4px 8px;opacity:0.6">회사명</td><td><b>${company || '-'}</b></td></tr>
        <tr><td style="padding:4px 8px;opacity:0.6">성함</td><td>${name || '-'}</td></tr>
        <tr><td style="padding:4px 8px;opacity:0.6">연락처</td><td><b>${phone || '-'}</b></td></tr>
        <tr><td style="padding:4px 8px;opacity:0.6">이메일</td><td>${email || '-'}</td></tr>
        <tr><td style="padding:4px 8px;opacity:0.6;vertical-align:top">메모</td><td>${(notes||'-').replace(/\n/g,'<br>')}</td></tr>
      </table>
      <h3 style="color:#6b4e3a;margin-top:24px">대화 내용</h3>
      ${renderTranscriptHtml(transcript)}
    </div>
  `;

  // 3) 이메일 발송 (또는 dry-run)
  let emailSent = false;
  let emailError = null;

  if (!transporter) {
    console.log('[consult] DRY-RUN — would have sent to:', CONSULT_TO);
    console.log('[consult] subject:', subject);
    emailError = 'SMTP_NOT_CONFIGURED';
  } else {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: CONSULT_TO.join(','),
        replyTo: email || undefined,
        subject,
        text: plainBody,
        html: htmlBody,
      });
      emailSent = true;
      console.log('[consult] email sent to', CONSULT_TO.join(','));
    } catch (err) {
      emailError = err.message;
      console.error('[consult] sendMail failed:', err.message);
    }
  }

  // 4) DB 에 발송 결과 업데이트
  if (requestId && !db.DISABLED) {
    try {
      await db.query(
        `UPDATE consultation_request
            SET email_sent = $1, email_sent_ts = $2, email_error = $3
          WHERE id = $4`,
        [emailSent, emailSent ? new Date() : null, emailError, requestId]
      );
    } catch (err) {
      console.error('[consult] failed to update email status:', err.message);
    }
  }

  // 5) 응답 — 이메일 실패해도 DB 저장됐으면 ok
  const status = emailSent ? 'email_sent' : (requestId ? 'logged_only' : 'no_record');
  res.json({
    ok: emailSent || !!requestId,
    status,
    requestId,
    emailSent,
    // 클라이언트에 에러 상세를 노출하지 않음 (민감할 수 있음)
  });
});

module.exports = router;
