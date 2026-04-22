// routes/chat.js — POST /api/chat
//
// 기존 server.js 의 인라인 /api/chat 을 이관. 추가된 기능:
//   1. session_id 지원 (클라이언트 localStorage UUID). 없으면 auto-gen 해서 응답에 실어보냄.
//   2. 매 턴 user + assistant 메시지를 chat_log 에 저장 (DB 없어도 앱은 계속 동작).
//   3. 불만족 신호(6종) 자동 탐지해서 assistant 행의 flags 컬럼에 기록.
//   4. persona 는 당분간 'unknown' 으로 기록 (추후 설계 예정).
//
// 시스템 프롬프트는 아직 기존 단일 버전 유지. prompts/b2c.js + prompts/b2b.js 로
// 분리하는 작업은 이 파일의 마지막 TODO.

const crypto = require('crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const db = require('../db');
const persona = require('../lib/persona');
const dissat = require('../lib/dissatisfaction');

const router = express.Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

// === 오라운트 커피 DB (기존 server.js 에서 이관) ===
const COFFEE_DATABASE = `
오라운트 커피는 경기광주에 위치한 세계 최대 로스터리 카페입니다.
구글, 위워크 같은 글로벌 기업에 원두를 납품하고 있습니다.

=== 판매 중인 원두 ===

1. 운트 블렌드 (고소한맛) - 29,000원/1kg
   - 원산지: 콜롬비아 40%, 케냐 20%, 과테말라 40%
   - 로스팅: 미디엄 다크
   - 맛: 진하고 고소한 바디감, 다크 초콜릿과 견과류 풍미
   - 산미: 낮음 - 바디: 진함
   - 추천: 라떼, 카푸치노, 에스프레소에 최적
   - 특징: 구글 오피스 납품 원두, 베스트셀러

2. 알소 블렌드 (산뜻한맛) - 37,500원/1kg
   - 원산지: 에티오피아 싱글 오리진
   - 로스팅: 라이트 미디엄
   - 맛: 플로랄 향미의 아로마, 시트러스와 베리 향
   - 산미: 높음 - 바디: 가벼움
   - 추천: 핸드드립, 푸어오버에 최적
   - 특징: 꽃향기와 과일향이 풍부, 산미 애호가용

3. 이웃 블렌드 (달콤한맛) - 28,500원/1kg
   - 원산지: 브라질 블렌드
   - 로스팅: 미디엄
   - 맛: 부드럽고 달콤한 맛, 캐러멜과 초콜릿 풍미
   - 산미: 중간 - 바디: 중간
   - 추천: 아메리카노, 콜드브루에 좋음
   - 특징: 초보자도 부담없이 즐길 수 있는 밸런스

4. 베커라이 블렌드 (고소한맛) - 28,000원/1kg
   - 원산지: 중남미 블렌드
   - 로스팅: 미디엄 다크
   - 맛: 베이커리에 어울리는 고소한 맛
   - 산미: 낮음
   - 추천: 빵, 디저트와 함께

5. 콜롬비아 디카페인 - 39,000원/1kg
   - 원산지: 콜롬비아 싱글 오리진
   - 로스팅: 미디엄
   - 맛: 카페인 없이도 풍부한 맛과 바디감
   - 산미: 중간
   - 특징: 임산부, 카페인 민감자, 저녁용

=== 커피키트 ===
- 이지드립 20입: 18g × 20개 드립백 - 36,000원
- 콜드브루: 깊고 진한 운트 블렌드 - 5,500원

=== 추천 가이드 ===
- 진한 커피 선호 → 운트 블렌드, 베커라이 블렌드
- 산미 선호 → 알소 블렌드
- 부드러운 맛 → 이웃 블렌드
- 카페인 민감 → 디카페인
- 라떼/우유 → 운트 블렌드
- 핸드드립 → 알소 블렌드
- 콜드브루 → 이웃 블렌드, 운트 블렌드
`;

const SYSTEM_PROMPT = `당신은 오라운트 커피의 친절한 원두 추천 전문가입니다.

${COFFEE_DATABASE}

고객의 취향을 파악하여 가장 적합한 원두를 추천해주세요.

다음 규칙을 따라주세요:
1. 친근하고 전문적인 톤 사용
2. 2-4문장으로 간결하게 답변
3. 구체적인 원두 이름과 가격 언급
4. 고객의 취향에 맞는 이유 설명
5. 필요시 추가 질문으로 취향 파악
6. 이모지를 적절히 사용하여 친근함 표현

예시 대화:
고객: "진한 커피 좋아해요"
답변: "진한 커피를 선호하시는군요! 운트 블렌드(29,000원)를 추천드립니다. ☕ 콜롬비아·케냐·과테말라를 블렌딩한 미디엄 다크 로스팅으로, 다크 초콜릿과 견과류 풍미가 풍부해요. 구글 오피스에서도 선택한 베스트셀러랍니다! 라떼나 에스프레소로 즐기시면 최고예요. 🎯"

고객의 니즈를 정확히 파악하고 최적의 원두를 추천해주세요!`;


// === 헬퍼 ===

function newSessionId() {
  return crypto.randomUUID();
}

// PIPA: 원본 IP 대신 하루 단위 salt 를 섞은 해시 저장.
// 같은 날 동일 IP → 동일 해시, 날이 바뀌면 리셋.
function hashIp(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket?.remoteAddress
          || '';
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  return crypto.createHash('sha256')
    .update(ip + ':' + day)
    .digest('hex')
    .slice(0, 16);  // 16자만 — 분석에는 충분
}

async function logChatRow(row) {
  if (db.DISABLED) return;
  try {
    await db.query(
      `INSERT INTO chat_log
        (session_id, role, content, persona, model, tokens_in, tokens_out, flags, user_agent, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.session_id,
        row.role,
        row.content,
        row.persona || 'unknown',
        row.model || null,
        row.tokens_in || null,
        row.tokens_out || null,
        JSON.stringify(row.flags || {}),
        row.user_agent || null,
        row.ip_hash || null,
      ]
    );
  } catch (err) {
    // 로깅 실패는 사용자 경험을 해치면 안 됨 — 콘솔에만 찍고 넘어감.
    console.error('[chat] failed to log row:', err.message);
  }
}


// === POST /api/chat ===
router.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    let { sessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: '메시지가 필요합니다.' });
    }
    if (!sessionId) sessionId = newSessionId();

    const userAgent = req.headers['user-agent'] || null;
    const ipHash = hashIp(req);

    // 페르소나 분류 — 첫 유저 메시지 기준.
    // 현재는 'unknown' 만 반환되지만, 장래에 sticky 처리를 위해 세션의 첫 턴만 판정.
    const firstUserMsg = history.find(m => m.role === 'user')?.content || message;
    const personaType = persona.classify(firstUserMsg);

    // Claude messages 형식으로 변환
    const messages = history.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
    messages.push({ role: 'user', content: message });

    // 1) 유저 메시지 먼저 기록 (Claude 호출 실패해도 남김)
    await logChatRow({
      session_id: sessionId,
      role: 'user',
      content: message,
      persona: personaType,
      user_agent: userAgent,
      ip_hash: ipHash,
    });

    // 2) Claude 호출
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content[0].text;

    // 3) 불만족 신호 탐지
    const prevUserMsgs = history.filter(m => m.role === 'user').map(m => m.content);
    const flags = dissat.detectAll({
      userMsg: message,
      assistantMsg: reply,
      prevUserMsgs,
    });

    // 4) assistant 응답 기록
    await logChatRow({
      session_id: sessionId,
      role: 'assistant',
      content: reply,
      persona: personaType,
      model: MODEL,
      tokens_in: response.usage?.input_tokens,
      tokens_out: response.usage?.output_tokens,
      flags,
      user_agent: userAgent,
      ip_hash: ipHash,
    });

    res.json({ reply, sessionId });

  } catch (error) {
    console.error('[chat] Claude API error:', error);
    res.status(500).json({
      error: '죄송합니다. 일시적인 오류가 발생했습니다.',
      details: error.message,
    });
  }
});

module.exports = router;
