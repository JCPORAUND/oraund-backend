// routes/chat.js — POST /api/chat
//
// 기능:
//   1. session_id 지원 (클라이언트 localStorage UUID). 없으면 auto-gen.
//   2. 매 턴 user + assistant 메시지를 chat_log 에 저장 (DB 없어도 앱 동작).
//   3. 불만족 신호(6종) 자동 탐지 → assistant 행의 flags 컬럼에 기록.
//   4. 페르소나 분기 + 서브 페르소나 힌트 주입 + 모델 라우팅:
//        - 첫 턴 (history.length === 0) → 무조건 Haiku + B2C 프롬프트
//          (첫 응답 속도가 체감을 결정하므로 속도 우선)
//        - 이후 턴 → persona.classifyFromHistory() 결과에 따라
//            b2b.oem  → Sonnet + B2B + OEM 힌트 (🚨 즉시 휴먼 에스컬레이션)
//            b2b.*    → Sonnet + B2B + 서브 힌트
//            b2b      → Sonnet + B2B (서브 힌트 없음)
//            b2c.*    → Haiku  + B2C + 서브 힌트
//            b2c / unknown → Haiku + B2C (서브 힌트 없음)
//
// DB 에는 persona='b2b'|'b2c'|'unknown', flags.subpersona='b2b.oem' 등 기록 →
// 나중에 서브 페르소나별 유입/전환 분석 가능.
//
// 모델은 환경변수로 재정의 가능:
//   CLAUDE_MODEL_HAIKU  (기본: claude-haiku-4-5)
//   CLAUDE_MODEL_SONNET (기본: claude-sonnet-4-20250514, 기존 CLAUDE_MODEL 도 수용)

const crypto = require('crypto');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const db = require('../db');
const persona = require('../lib/persona');
const dissat = require('../lib/dissatisfaction');
const { buildSystemPrompt } = require('../prompts');

const router = express.Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 모델 두 개 — 역할별로 분리.
// 기존 CLAUDE_MODEL 환경변수는 호환성을 위해 Sonnet 쪽으로 fallback.
const HAIKU  = process.env.CLAUDE_MODEL_HAIKU  || 'claude-haiku-4-5';
const SONNET = process.env.CLAUDE_MODEL_SONNET || process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

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


// === 페르소나 / 서브 페르소나 / 모델 라우팅 ===
//
// routeRequest 는 이 턴에 어떤 모델 + 시스템 프롬프트를 쓸지 결정한다.
// 반환:
//   {
//     model:       string,     // Haiku or Sonnet ID
//     system:      string,     // 최종 시스템 프롬프트 (base + 서브 힌트)
//     persona:     string,     // 'b2b' | 'b2c' | 'unknown'
//     subpersona:  string|null,// 'b2b.oem' 등
//     subpersonaTags: string[],// 감지된 모든 서브 태그
//     reason:      string,     // 라우팅 결정 이유 (로그용)
//   }
//
// 규칙:
//   1. 첫 턴 (history.length === 0) → Haiku + B2C 베이스 (서브 힌트 없음)
//      - 체감 속도가 가장 중요한 순간. 첫 인상은 친근한 톤이 안전한 기본값.
//      - 서브 페르소나는 classifyFromHistory 가 currentMessage 만으로도 감지하긴 하지만,
//        첫 턴에는 일단 힌트 없이 가볍게 받고, 2턴부터 본격 라우팅.
//   2. 이후 턴 → persona.classifyFromHistory(history, message) 결과
//      - persona === 'b2b' → Sonnet + B2B base + (서브 힌트 있으면 추가)
//      - persona === 'b2c'/'unknown' → Haiku + B2C base + (서브 힌트 있으면 추가)
function routeRequest(history, currentMessage) {
  const isFirstTurn = !Array.isArray(history) || history.length === 0;

  if (isFirstTurn) {
    return {
      model: HAIKU,
      system: buildSystemPrompt('b2c', null),
      persona: 'unknown',
      subpersona: null,
      subpersonaTags: [],
      reason: 'first-turn',
    };
  }

  const result = persona.classifyFromHistory(history, currentMessage);

  if (result.persona === 'b2b') {
    return {
      model: SONNET,
      system: buildSystemPrompt('b2b', result.subpersona),
      persona: 'b2b',
      subpersona: result.subpersona,
      subpersonaTags: result.subpersonaTags,
      reason: result.subpersona
        ? `b2b-sub:${result.subpersona}`
        : 'b2b-generic',
    };
  }

  // b2c or unknown — 둘 다 Haiku + B2C 로
  return {
    model: HAIKU,
    system: buildSystemPrompt('b2c', result.subpersona),
    persona: result.persona,                        // 'b2c' 또는 'unknown' 그대로
    subpersona: result.subpersona,                  // null 일 수 있음
    subpersonaTags: result.subpersonaTags,
    reason: result.subpersona
      ? `b2c-sub:${result.subpersona}`
      : (result.persona === 'b2c' ? 'b2c-generic' : 'default'),
  };
}


// === POST /api/chat ===
router.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [], memberId, context } = req.body;
    let { sessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: '메시지가 필요합니다.' });
    }
    if (!sessionId) sessionId = newSessionId();

    const userAgent = req.headers['user-agent'] || null;
    const ipHash = hashIp(req);

    // 이번 턴의 모델 / 프롬프트 / 페르소나 결정
    const route = routeRequest(history, message);

    // === Optional context injection ===
    // If memberId is provided AND context indicates custom blend, fetch order summary
    // and append to system prompt so Claude can give personalised recommendations.
    let extraSystem = '';
    // B2C customblend — customer building their own 1kg blend (product-customblend.html)
    if (memberId && context === 'customblend') {
      try {
        const cafe24 = require('../lib/cafe24-client');
        const { summariseOrders } = require('../lib/order-summary');
        const orders = await cafe24.getCustomerOrders(memberId, { limit: 30 });
        const summary = summariseOrders(orders);
        if (summary && summary.total_items > 0) {
          extraSystem = `\n\n【고객 구매 내역 (커스텀 블렌드 추천용)】\n` +
            `최근 주문 ${summary.order_count}건, 총 ${summary.total_items}개 상품.\n` +
            `자주 산 원두: ${summary.top_beans.map(b => `${b.id}(×${b.qty})`).join(', ')}\n` +
            `취향 분포: ${JSON.stringify(summary.taste_distribution)}\n` +
            `주된 취향: ${summary.dominant_taste || '-'}\n\n` +
            `위 내역을 참고해서 커스텀 블렌드를 추천하세요. 베이스(50%) · 두 번째(30%) · 세 번째(20%) 비율로 3종 선택.\n` +
            `선택 가능한 베이스 3종: 콜롬비아 수프리모(고소), 에티오피아 아리차 내추럴(산뜻), 콜롬비아 디카페인.\n` +
            `2번째·3번째 4종: 수프리모, 아리차 내추럴, 아리차 워시드, 콜롬비아 디카페인.`;
        } else {
          extraSystem = `\n\n【고객 구매 내역】\n해당 회원의 주문 내역이 없습니다. 일반 질문 기반으로 커스텀 블렌드를 추천하세요. 베이스 3종(수프리모/아리차내추럴/디카페인) + 2번째·3번째 4종(수프리모/아리차내추럴/아리차워시드/디카페인) 중 선택.`;
        }
      } catch (e) {
        console.warn('[chat] order summary fetch failed:', e.message);
      }
    }

    // B2B custom blend — wholesale sample requester (wholesale-sample.html)
    if (context === 'customblend-b2b') {
      extraSystem = `\n\n【B2B 커스텀 블렌드 샘플 가이드】\n` +
        `사용자는 사업자(카페·로스터리·기업)로, 무료 샘플 요청 폼에서 "AI 커스텀 블렌드"를 선택했습니다.\n` +
        `목표: 사용자의 사업 컨셉·메뉴·예상 추출 방식·맛 선호를 파악해 ORAUND가 개발할 커스텀 블렌드 스펙을 정리.\n\n` +
        `대화 흐름 (3~5문답으로 마무리):\n` +
        `1. 사업 유형 (개인 카페 / 호텔 / 기업 사무실 / 어메니티 등)과 월 예상 사용량.\n` +
        `2. 메인 메뉴 (에스프레소 베이스 / 핸드드립 / 콜드브루 / 라떼 중심 등).\n` +
        `3. 맛 방향 (고소·다크초콜릿 / 산뜻·과일향 / 달콤·캐러멜 등) + 로스팅 강도 (라이트/미디엄/다크).\n` +
        `4. 참고 원두 (다른 로스터의 어떤 블렌드와 비슷한 느낌?).\n\n` +
        `필요한 정보를 다 얻으면 마지막에 다음 형식으로 정리하세요:\n` +
        `"【커스텀 블렌드 요청 정리】\n` +
        `- 사업 유형: ...\n` +
        `- 메인 메뉴: ...\n` +
        `- 맛 방향·로스팅: ...\n` +
        `- 참고 원두: ...\n` +
        `- 추천 베이스 (예상): 운트 블렌드 70% + ... 등"\n\n` +
        `사용자가 이 정리를 보고 폼의 'AI와 함께 만든 블렌드 내역' 필드에 복사할 수 있도록 명확하게.\n` +
        `B2B MOQ는 4kg, 무료 샘플은 400g × 최대 2종. 견적 단가는 사업팀이 별도 안내.`;
    }

    console.log(
      `[chat] ${sessionId.slice(0,8)} turn=${history.length/2|0} ` +
      `persona=${route.persona} sub=${route.subpersona || '-'} ` +
      `model=${route.model} memberCtx=${memberId ? 'Y' : 'N'} (${route.reason})`
    );

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
      persona: route.persona,
      flags: {
        subpersona: route.subpersona,
        subpersona_tags: route.subpersonaTags,
      },
      user_agent: userAgent,
      ip_hash: ipHash,
    });

    // 2) Claude 호출
    const response = await anthropic.messages.create({
      model: route.model,
      max_tokens: 500,
      system: route.system + extraSystem,
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
      persona: route.persona,
      model: route.model,
      tokens_in: response.usage?.input_tokens,
      tokens_out: response.usage?.output_tokens,
      flags: {
        ...flags,
        subpersona: route.subpersona,
        subpersona_tags: route.subpersonaTags,
        _route_reason: route.reason,
      },
      user_agent: userAgent,
      ip_hash: ipHash,
    });

    res.json({
      reply,
      sessionId,
      persona: route.persona,
      subpersona: route.subpersona,
    });

  } catch (error) {
    console.error('[chat] Claude API error:', error);
    res.status(500).json({
      error: '죄송합니다. 일시적인 오류가 발생했습니다.',
      details: error.message,
    });
  }
});

module.exports = router;
