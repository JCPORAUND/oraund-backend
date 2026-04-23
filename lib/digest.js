// lib/digest.js — 일일 다이제스트 (어제자 채팅 활동 요약 → 관리자 이메일)
//
// 기능:
//   buildDigest(dateISO)  — chat_log + consultation_request 를 집계해 plain/html 문자열 생성
//   sendDigest(dateISO)   — buildDigest 결과를 nodemailer 로 DIGEST_TO 에 발송
//
// dateISO: 'YYYY-MM-DD' — KST 기준 하루치. 예: '2026-04-22' → KST 2026-04-22 00:00~24:00
//
// 환경변수:
//   SMTP_*, SMTP_FROM     — routes/consult.js 와 동일. 별도 transporter 를 따로 만든다.
//   DIGEST_TO             — 기본 info@oraund.com,bywockd@gmail.com
//   DIGEST_TZ_OFFSET_HR   — 기본 9 (KST). 테스트용.
//
// DB 가 DISABLED 이거나 SMTP 미설정이면 그냥 no-op. 호출자에게 status 객체 반환.

const nodemailer = require('nodemailer');
const db = require('../db');

const DIGEST_TO = (process.env.DIGEST_TO || 'info@oraund.com,bywockd@gmail.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const TZ_OFFSET_HR = parseInt(process.env.DIGEST_TZ_OFFSET_HR || '9', 10);

const SMTP_CONFIGURED = !!(
  process.env.SMTP_HOST && process.env.SMTP_PORT &&
  process.env.SMTP_USER && process.env.SMTP_PASS
);

let _transporter = null;
function getTransporter() {
  if (_transporter || !SMTP_CONFIGURED) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: parseInt(process.env.SMTP_PORT, 10) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transporter;
}

// === date helpers ===
// KST 기준 'YYYY-MM-DD' 하루의 UTC 경계를 계산.
function dayRangeUtc(dateISO) {
  // dateISO 는 KST 기준 날짜.
  // KST 2026-04-22 00:00 = UTC 2026-04-21 15:00
  const [y, m, d] = dateISO.split('-').map(Number);
  const startUtc = new Date(Date.UTC(y, m - 1, d, 0 - TZ_OFFSET_HR, 0, 0));
  const endUtc = new Date(Date.UTC(y, m - 1, d + 1, 0 - TZ_OFFSET_HR, 0, 0));
  return { startUtc, endUtc };
}

function yesterdayKstISO(now = new Date()) {
  // 서버 UTC now → KST 로 shift → 하루 빼기 → YYYY-MM-DD
  const kst = new Date(now.getTime() + TZ_OFFSET_HR * 3600 * 1000);
  kst.setUTCDate(kst.getUTCDate() - 1);
  return kst.toISOString().slice(0, 10);
}

// === aggregation ===

async function buildDigest(dateISO) {
  const { startUtc, endUtc } = dayRangeUtc(dateISO);

  if (db.DISABLED) {
    return {
      date: dateISO,
      dbDisabled: true,
      subject: `[ORAUND 일일요약] ${dateISO} — DB 비활성화`,
      textBody: `DB 가 DISABLED 상태이므로 집계 불가능. (DATABASE_URL 미설정?)`,
      htmlBody: `<p>DB 가 <b>DISABLED</b> 상태이므로 집계 불가능. (DATABASE_URL 미설정?)</p>`,
      stats: null,
    };
  }

  // 1) 기본 카운트 (세션 / 메시지 / 역할)
  const { rows: countRows } = await db.query(
    `SELECT
        COUNT(DISTINCT session_id)::int AS sessions,
        COUNT(*)::int                   AS messages,
        SUM(CASE WHEN role='user' THEN 1 ELSE 0 END)::int      AS user_msgs,
        SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END)::int AS ai_msgs,
        COALESCE(SUM(tokens_in), 0)::int  AS tok_in,
        COALESCE(SUM(tokens_out), 0)::int AS tok_out
     FROM chat_log
     WHERE ts >= $1 AND ts < $2`,
    [startUtc, endUtc]
  );
  const c = countRows[0] || {};

  // 2) persona 분포
  const { rows: personaRows } = await db.query(
    `SELECT persona, COUNT(*)::int AS n
       FROM chat_log
      WHERE ts >= $1 AND ts < $2
   GROUP BY persona
   ORDER BY n DESC`,
    [startUtc, endUtc]
  );

  // 3) flag 집계 — flags JSONB 에 true 가 있는 메시지 수 (신호별)
  const { rows: flagRows } = await db.query(
    `SELECT
        SUM((flags->>'frustration')::boolean::int)::int   AS frustration,
        SUM((flags->>'repeated_q')::boolean::int)::int    AS repeated_q,
        SUM((flags->>'hallucination')::boolean::int)::int AS hallucination,
        SUM((flags->>'giveup')::boolean::int)::int        AS giveup,
        SUM((flags->>'refusal')::boolean::int)::int       AS refusal
     FROM chat_log
     WHERE ts >= $1 AND ts < $2
       AND role = 'assistant'`,
    [startUtc, endUtc]
  );
  const f = flagRows[0] || {};

  // 4) flagged session 샘플 (최대 5개, 하나라도 true 인 대화)
  const { rows: flaggedSessions } = await db.query(
    `SELECT session_id,
            MIN(ts) AS first_ts,
            MAX(persona) AS persona,
            BOOL_OR((flags->>'frustration')::boolean)   AS frustration,
            BOOL_OR((flags->>'repeated_q')::boolean)    AS repeated_q,
            BOOL_OR((flags->>'hallucination')::boolean) AS hallucination,
            BOOL_OR((flags->>'giveup')::boolean)        AS giveup,
            BOOL_OR((flags->>'refusal')::boolean)       AS refusal
       FROM chat_log
      WHERE ts >= $1 AND ts < $2
        AND role = 'assistant'
        AND flags <> '{}'::jsonb
        AND (
             (flags->>'frustration')::boolean
          OR (flags->>'repeated_q')::boolean
          OR (flags->>'hallucination')::boolean
          OR (flags->>'giveup')::boolean
          OR (flags->>'refusal')::boolean
        )
   GROUP BY session_id
   ORDER BY first_ts DESC
      LIMIT 5`,
    [startUtc, endUtc]
  );

  // 5) 상담 요청
  const { rows: consults } = await db.query(
    `SELECT id, ts, name, company, phone, email, email_sent, email_error
       FROM consultation_request
      WHERE ts >= $1 AND ts < $2
   ORDER BY ts DESC`,
    [startUtc, endUtc]
  );

  const stats = {
    sessions: c.sessions || 0,
    messages: c.messages || 0,
    userMsgs: c.user_msgs || 0,
    aiMsgs: c.ai_msgs || 0,
    tokensIn: c.tok_in || 0,
    tokensOut: c.tok_out || 0,
    personas: personaRows,
    flags: {
      frustration:   f.frustration   || 0,
      repeated_q:    f.repeated_q    || 0,
      hallucination: f.hallucination || 0,
      giveup:        f.giveup        || 0,
      refusal:       f.refusal       || 0,
    },
    flaggedSessions,
    consults,
  };

  const subject = stats.sessions === 0
    ? `[ORAUND 일일요약] ${dateISO} — 활동 없음`
    : `[ORAUND 일일요약] ${dateISO} — 세션 ${stats.sessions}건 / 상담 ${stats.consults.length}건`;

  const textBody = renderPlain(dateISO, stats);
  const htmlBody = renderHtml(dateISO, stats);

  return { date: dateISO, dbDisabled: false, subject, textBody, htmlBody, stats };
}

// === renderers ===

function renderPlain(dateISO, s) {
  const lines = [];
  lines.push(`=== ORAUND 일일 다이제스트 (${dateISO} KST) ===`);
  lines.push('');
  lines.push('[ 활동 ]');
  lines.push(`  세션 수      : ${s.sessions}`);
  lines.push(`  전체 메시지  : ${s.messages}  (user ${s.userMsgs} / ai ${s.aiMsgs})`);
  lines.push(`  토큰         : in ${s.tokensIn.toLocaleString()} / out ${s.tokensOut.toLocaleString()}`);
  lines.push('');
  lines.push('[ Persona 분포 ]');
  if (!s.personas.length) {
    lines.push('  (데이터 없음)');
  } else {
    for (const p of s.personas) {
      lines.push(`  ${p.persona.padEnd(8)} : ${p.n}`);
    }
  }
  lines.push('');
  lines.push('[ 불만족 신호 (assistant 메시지 기준) ]');
  lines.push(`  frustration  : ${s.flags.frustration}`);
  lines.push(`  repeated_q   : ${s.flags.repeated_q}`);
  lines.push(`  hallucination: ${s.flags.hallucination}`);
  lines.push(`  giveup       : ${s.flags.giveup}`);
  lines.push(`  refusal      : ${s.flags.refusal}`);
  lines.push('');
  lines.push('[ 주의가 필요한 세션 (최대 5개) ]');
  if (!s.flaggedSessions.length) {
    lines.push('  없음 ✨');
  } else {
    for (const row of s.flaggedSessions) {
      const flags = [
        row.frustration   && 'frustration',
        row.repeated_q    && 'repeated_q',
        row.hallucination && 'hallucination',
        row.giveup        && 'giveup',
        row.refusal       && 'refusal',
      ].filter(Boolean).join(',');
      lines.push(`  - ${row.session_id.slice(0, 8)}… (${row.persona || 'unknown'}) [${flags}]`);
    }
  }
  lines.push('');
  lines.push('[ 상담 요청 ]');
  if (!s.consults.length) {
    lines.push('  없음');
  } else {
    for (const c of s.consults) {
      const sent = c.email_sent ? '✅' : (c.email_error ? `❌ ${c.email_error}` : '⏳');
      lines.push(`  #${c.id} ${c.company || c.name || '-'} / ${c.phone || c.email || '-'} ${sent}`);
    }
  }
  lines.push('');
  lines.push('— 오라운트 AI');
  return lines.join('\n');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(dateISO, s) {
  const personaRows = s.personas.length
    ? s.personas.map(p => `<tr><td style="padding:4px 12px">${esc(p.persona)}</td><td style="padding:4px 12px;text-align:right"><b>${p.n}</b></td></tr>`).join('')
    : `<tr><td colspan="2" style="padding:8px;opacity:0.6">(데이터 없음)</td></tr>`;

  const flagRows = Object.entries(s.flags).map(([k, v]) => {
    const color = v > 0 ? '#c0392b' : '#999';
    return `<tr><td style="padding:4px 12px">${esc(k)}</td><td style="padding:4px 12px;text-align:right;color:${color}"><b>${v}</b></td></tr>`;
  }).join('');

  const flaggedRows = s.flaggedSessions.length
    ? s.flaggedSessions.map(row => {
        const chips = [
          row.frustration   && '<span style="background:#fdecea;color:#c0392b;padding:2px 6px;border-radius:3px;margin-right:4px">frustration</span>',
          row.repeated_q    && '<span style="background:#fff4e5;color:#b85c00;padding:2px 6px;border-radius:3px;margin-right:4px">repeated_q</span>',
          row.hallucination && '<span style="background:#ffeaa7;color:#8a6100;padding:2px 6px;border-radius:3px;margin-right:4px">hallucination</span>',
          row.giveup        && '<span style="background:#eeeeee;color:#555;padding:2px 6px;border-radius:3px;margin-right:4px">giveup</span>',
          row.refusal       && '<span style="background:#ecf2fd;color:#2c5fc7;padding:2px 6px;border-radius:3px;margin-right:4px">refusal</span>',
        ].filter(Boolean).join('');
        return `<tr>
          <td style="padding:6px 12px;font-family:monospace;font-size:12px">${esc(row.session_id.slice(0, 12))}…</td>
          <td style="padding:6px 12px">${esc(row.persona || 'unknown')}</td>
          <td style="padding:6px 12px">${chips}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="3" style="padding:12px;opacity:0.6;text-align:center">없음 ✨</td></tr>`;

  const consultRows = s.consults.length
    ? s.consults.map(c => {
        const status = c.email_sent
          ? '<span style="color:#2a7d2a">✅ 전송</span>'
          : (c.email_error
              ? `<span style="color:#c0392b">❌ ${esc(c.email_error.slice(0, 40))}</span>`
              : '<span style="color:#999">⏳ 대기</span>');
        return `<tr>
          <td style="padding:6px 12px">#${c.id}</td>
          <td style="padding:6px 12px">${esc(c.company || c.name || '-')}</td>
          <td style="padding:6px 12px">${esc(c.phone || c.email || '-')}</td>
          <td style="padding:6px 12px">${status}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="4" style="padding:12px;opacity:0.6;text-align:center">없음</td></tr>`;

  return `
  <div style="font-family:-apple-system,'Helvetica Neue',sans-serif;max-width:720px;margin:auto;color:#333">
    <h2 style="color:#6b4e3a;border-bottom:2px solid #6b4e3a;padding-bottom:8px">
      ☕ ORAUND 일일 다이제스트
      <span style="font-size:14px;opacity:0.6;font-weight:normal">${esc(dateISO)} KST</span>
    </h2>

    <h3 style="color:#6b4e3a;margin-top:24px">활동 개요</h3>
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 12px;opacity:0.6;width:160px">세션 수</td><td style="padding:6px 12px"><b style="font-size:18px">${s.sessions}</b></td></tr>
      <tr style="background:#f7f5f0"><td style="padding:6px 12px;opacity:0.6">전체 메시지</td><td style="padding:6px 12px"><b>${s.messages}</b> <span style="opacity:0.6">(user ${s.userMsgs} / ai ${s.aiMsgs})</span></td></tr>
      <tr><td style="padding:6px 12px;opacity:0.6">토큰 사용량</td><td style="padding:6px 12px">in <b>${s.tokensIn.toLocaleString()}</b> / out <b>${s.tokensOut.toLocaleString()}</b></td></tr>
    </table>

    <table style="width:100%;margin-top:24px;font-size:14px;border-collapse:collapse">
      <tr>
        <td style="vertical-align:top;width:50%;padding-right:12px">
          <h3 style="color:#6b4e3a">Persona 분포</h3>
          <table style="width:100%;border:1px solid #eee;border-collapse:collapse">${personaRows}</table>
        </td>
        <td style="vertical-align:top;width:50%;padding-left:12px">
          <h3 style="color:#6b4e3a">불만족 신호</h3>
          <table style="width:100%;border:1px solid #eee;border-collapse:collapse">${flagRows}</table>
        </td>
      </tr>
    </table>

    <h3 style="color:#6b4e3a;margin-top:24px">주의가 필요한 세션 (최대 5)</h3>
    <table style="width:100%;font-size:13px;border:1px solid #eee;border-collapse:collapse">
      <thead style="background:#f7f5f0">
        <tr><th style="padding:8px 12px;text-align:left">Session</th><th style="padding:8px 12px;text-align:left">Persona</th><th style="padding:8px 12px;text-align:left">Flags</th></tr>
      </thead>
      <tbody>${flaggedRows}</tbody>
    </table>

    <h3 style="color:#6b4e3a;margin-top:24px">상담 요청</h3>
    <table style="width:100%;font-size:13px;border:1px solid #eee;border-collapse:collapse">
      <thead style="background:#f7f5f0">
        <tr><th style="padding:8px 12px;text-align:left">#</th><th style="padding:8px 12px;text-align:left">회사/이름</th><th style="padding:8px 12px;text-align:left">연락처</th><th style="padding:8px 12px;text-align:left">메일</th></tr>
      </thead>
      <tbody>${consultRows}</tbody>
    </table>

    <p style="margin-top:32px;opacity:0.5;font-size:12px;text-align:center">— 오라운트 AI · 자동 발송</p>
  </div>`;
}

// === send ===

async function sendDigest(dateISO) {
  const d = dateISO || yesterdayKstISO();
  const digest = await buildDigest(d);

  const t = getTransporter();
  if (!t) {
    console.warn('[digest] SMTP not configured — DRY RUN for', d);
    console.log('[digest] subject:', digest.subject);
    return { ok: false, status: 'SMTP_NOT_CONFIGURED', date: d, digest };
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: DIGEST_TO.join(','),
      subject: digest.subject,
      text: digest.textBody,
      html: digest.htmlBody,
    });
    console.log('[digest] sent to', DIGEST_TO.join(','), '— date:', d);
    return { ok: true, status: 'sent', date: d, to: DIGEST_TO };
  } catch (err) {
    console.error('[digest] sendMail failed:', err.message);
    return { ok: false, status: 'send_failed', error: err.message, date: d };
  }
}

module.exports = { buildDigest, sendDigest, yesterdayKstISO };
