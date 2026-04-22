// lib/persona.js — B2C / B2B 페르소나 분류
//
// 동작 방식:
//   - 세션의 전체 대화 히스토리를 스캔.
//   - B2B 신호가 하나라도 있으면 'b2b'. (sticky — 한 번 b2b 면 계속 b2b)
//   - B2C 신호만 있으면 'b2c'.
//   - 아무 신호도 없으면 'unknown'.
//
// Sticky 가 history 스캔으로 자연스럽게 달성됨 → session-level cache 불필요.
// Railway 가 수평 확장돼도 문제 없음 (stateless).
//
// classifyFromHistory(history, currentMessage)
//   history: [{role, content}, ...]  — routes/chat.js 가 넘겨주는 그대로
//   currentMessage: string  — 이번 턴의 user message
//   returns: 'b2b' | 'b2c' | 'unknown'

// -- B2B 키워드 -------------------------------------------------------------
// 사업 컨텍스트, 대량 단위, 법인 서류, 납품/계약 용어.
// 한 번만 매치돼도 즉시 b2b 로 고정.
const B2B_PATTERNS = [
  // 비즈니스 맥락
  /도매/i,
  /납품/i,
  /벌크/i,
  /대량\s*(주문|구매|구입|매입)/i,
  /사업자(등록번호)?/i,
  /법인(카드|구매|명의)?/i,
  /세금\s*계산서/i,

  // 업태 — "카페 오픈", "카페 차리", "로스터리 운영" 등을 매치.
  // "카페에서 먹었어" 같은 소비자 발화는 매치되지 않도록 뒤에 업태/계약 단어 요구.
  /(카페|로스터리|커피\s*숍|매장|프랜차이즈)\s*(오픈|차리|창업|운영|납품|거래|계약|사장|대표)/i,
  /(카페|로스터리)\s*(용|에\s*쓸|에\s*사용)/i,

  // 양 단위 — "5kg 주문", "10키로", "20kg 보내주세요"
  // 1kg 은 개인도 쓸 수 있으니 5 이상 또는 "월 X kg" 만 잡음
  /\b([5-9]|[1-9]\d+)\s*(kg|키로|킬로|킬로그램)\b/i,
  /월\s*\d+\s*(kg|키로|킬로)/i,

  // 계약·정기
  /정기\s*(납품|배송|공급|계약)/i,
  /월\s*(정기|계약)/i,
  /OEM|ODM|PB|자사\s*브랜드/i,
  /MOQ|최소\s*주문/i,

  // B2B / 도매 직접 언급
  /\bB2B\b/i,
  /\b도매\s*(가|문의|상담)/i,
];

// -- B2C 키워드 -------------------------------------------------------------
// 홈카페·선물·취향 탐색 맥락. B2B 보다 약한 신호.
// 주의: 한글은 ASCII word boundary(\b)가 안 맞아서 \b 를 피하고 lookahead/주변 문맥으로.
const B2C_PATTERNS = [
  /홈카페/i,
  /집에서\s*[가-힣]{0,3}(마|먹|드|내)/i,  // 집에서 마실/먹을/드실/내려 등
  /(혼자|혼자서)\s*마시/i,
  /선물/i,
  /기프트/i,
  /(처음|초보|입문)/i,
  /드립백|이지드립/i,
  /한\s*봉지?/i,                       // "한 봉", "한 봉지" — \b 없이
  /취향/i,
  /무슨\s*맛|어떤\s*맛/i,
];


function matchAny(text, patterns) {
  if (!text) return false;
  return patterns.some((re) => re.test(text));
}

/**
 * 세션 전체 대화를 보고 페르소나 결정.
 * @param {Array<{role:string, content:string}>} history - routes/chat.js 가 넘겨주는 과거 메시지
 * @param {string} currentMessage - 이번 턴의 user 메시지
 * @returns {'b2b'|'b2c'|'unknown'}
 */
function classifyFromHistory(history, currentMessage) {
  const allUserText = [];

  if (Array.isArray(history)) {
    for (const m of history) {
      if (m && m.role === 'user' && typeof m.content === 'string') {
        allUserText.push(m.content);
      }
    }
  }
  if (typeof currentMessage === 'string' && currentMessage.trim()) {
    allUserText.push(currentMessage);
  }

  const joined = allUserText.join(' \n ');

  if (matchAny(joined, B2B_PATTERNS)) return 'b2b';
  if (matchAny(joined, B2C_PATTERNS)) return 'b2c';
  return 'unknown';
}

// 구 인터페이스 유지 — routes/chat.js 가 import 해놓은 `classify` 이름을 깨지 않게.
// firstUserMessage 만 들어오는 옛 호출에도 동일 결과를 주기 위해 단일 메시지 스캔.
function classify(firstUserMessage) {
  return classifyFromHistory([], firstUserMessage || '');
}

module.exports = {
  classify,
  classifyFromHistory,
  // 테스트 / 디버깅용 노출
  _B2B_PATTERNS: B2B_PATTERNS,
  _B2C_PATTERNS: B2C_PATTERNS,
};
