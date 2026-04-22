// lib/dissatisfaction.js — 불만족 신호 탐지
//
// 6가지 신호 (boolean flags):
//   frustration  : 강한 부정 표현 ("짜증", "쓸모없", "말귀 못알아듣", etc.)
//   repeated_q   : 같은 질문을 연속 2회 이상 (Jaccard 유사도 ≥ 0.6)
//   early_exit   : 세션 첫 메시지에서 끊김 (1턴만 대화 후 종료) — 이건 서버에서 판단 불가, 클라이언트 beforeunload 에서 /api/chat-end 호출해야 함. 현재는 stub.
//   hallucination: 답변에 오라운트에서 판매하지 않는 원두/제품 언급 ("게이샤" 등 DB 에 없는 이름)
//   giveup       : 유저의 "됐어요", "그만", "안되겠네요" 등 이탈 시그널
//   refusal      : Claude 의 거부 답변 ("답변드릴 수 없", "제가 도와드리기 어렵")
//
// 반환 형식: { [flagName]: boolean, … } — 하나라도 true 면 관리자 다이제스트에 포함.

// === 사전 ===

const FRUSTRATION_PATTERNS = [
  /짜증/, /답답/, /쓸모없/, /이해못/, /말귀/, /엉뚱/,
  /아니라/, /틀렸/, /잘못 알/, /못 알아듣/, /못알아듣/,
  /이거 왜/, /뭔 소리/, /이상해/,
];

const GIVEUP_PATTERNS = [
  /^됐어/, /^됐습니다/, /^됐네/, /그만/, /안되겠/,
  /다음에/, /나중에/, /필요없/, /필요 없/,
  /됐고/, /아 진짜/,
];

const REFUSAL_PATTERNS = [
  /답변드릴 수 없/, /답변할 수 없/, /도와드릴 수 없/,
  /도와드리기 어렵/, /죄송하지만.*없/, /제가 가진 정보/,
  /정확한 정보를 제공.*어렵/, /확인이 필요합니다/,
];

// 오라운트에서 파는 원두 (DB 에 있는 이름들). 이 외에 원두 이름이 나오면 hallucination 의심.
// server.js 의 COFFEE_DATABASE 와 동기화 필요.
const KNOWN_BEANS = [
  '운트', '알소', '이웃', '베커라이', '콜롬비아 디카',
  '콜롬비아 디카페인', '에티오피아 아리차', '예가체프', '파라이소',
  '바일 하프', '콜롬비아 수프리모',
];

// 흔히 헛소리로 나오는 외부 원두 이름들
const HALLUCINATION_BEANS = [
  '게이샤', '블루마운틴', '코피 루왁', '자메이카', 'Geisha',
];

// === 탐지기들 ===

function detectFrustration(userText) {
  if (!userText) return false;
  return FRUSTRATION_PATTERNS.some(p => p.test(userText));
}

function detectGiveup(userText) {
  if (!userText) return false;
  return GIVEUP_PATTERNS.some(p => p.test(userText));
}

function detectRefusal(assistantText) {
  if (!assistantText) return false;
  return REFUSAL_PATTERNS.some(p => p.test(assistantText));
}

function detectHallucination(assistantText) {
  if (!assistantText) return false;
  return HALLUCINATION_BEANS.some(b => assistantText.includes(b));
}

// Jaccard similarity on Korean char bigrams
function bigramSet(s) {
  const bg = new Set();
  for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2));
  return bg;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function detectRepeatedQ(currentUserText, prevUserTexts) {
  if (!currentUserText || !prevUserTexts || !prevUserTexts.length) return false;
  const cur = bigramSet(currentUserText.replace(/\s+/g, ''));
  if (cur.size < 3) return false;  // too short to be meaningful
  for (const prev of prevUserTexts.slice(-3)) {  // 최근 3개만 비교
    const p = bigramSet(prev.replace(/\s+/g, ''));
    if (jaccard(cur, p) >= 0.6) return true;
  }
  return false;
}

/**
 * 한 턴(유저→AI) 의 신호를 모두 계산.
 * @param {object} p
 * @param {string} p.userMsg          현재 유저 메시지
 * @param {string} p.assistantMsg     AI 응답
 * @param {string[]} [p.prevUserMsgs] 이 세션의 이전 유저 메시지들
 */
function detectAll({ userMsg, assistantMsg, prevUserMsgs }) {
  return {
    frustration:   detectFrustration(userMsg),
    repeated_q:    detectRepeatedQ(userMsg, prevUserMsgs || []),
    giveup:        detectGiveup(userMsg),
    refusal:       detectRefusal(assistantMsg),
    hallucination: detectHallucination(assistantMsg),
    // early_exit 는 클라이언트 사이드에서만 탐지 가능하므로 여기선 항상 false.
    // /api/chat-end 엔드포인트가 생기면 그쪽에서 세팅.
  };
}

function hasAnySignal(flags) {
  return Object.values(flags || {}).some(Boolean);
}

module.exports = {
  detectAll,
  hasAnySignal,
  // 테스트용 export
  _internals: {
    detectFrustration,
    detectGiveup,
    detectRefusal,
    detectHallucination,
    detectRepeatedQ,
    KNOWN_BEANS,
    HALLUCINATION_BEANS,
  },
};
