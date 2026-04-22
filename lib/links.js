// lib/links.js — 페르소나/서브 페르소나 → 관련 페이지 URL 매핑
//
// AI 가 대화 중 "페이지로 안내드릴까요?" 제안을 자연스럽게 하려면
// 시스템 프롬프트에 해당 페르소나와 매칭되는 URL 들이 주입돼야 한다.
//
// 구조:
//   getRelevantLinks(persona, subpersona) → [{label, url, when}, ...]
//
// 각 링크에는 "언제 안내하면 좋은지" (when) 힌트가 붙어 있어
// AI 가 대화 맥락에 맞게 선택해 제시한다.

const PAGES = {
  b2c_beans:    'https://oraund.com/product-beans-order.html',
  b2c_easydrip: 'https://oraund.com/product-easydrip.html',
  b2b_order:    'https://oraund.com/wholesale-order.html',
  b2b_sample:   'https://oraund.com/wholesale-sample.html',
};

// 서브 페르소나별 링크 큐레이션
// when: "~할 때 안내"  — AI 가 제시 타이밍 판단하는 힌트
const LINK_MAP = {
  // ========== B2C ==========
  'b2c.generic': [
    { label: '원두 주문 페이지',       url: PAGES.b2c_beans,    when: '원두 추천이 구체화되어 주문 단계로 넘어갈 때' },
    { label: '이지드립 (드립백) 페이지', url: PAGES.b2c_easydrip, when: '핸드드립 장비가 없거나 간편함을 원할 때' },
  ],
  'b2c.beginner': [
    { label: '이지드립 (드립백) 페이지', url: PAGES.b2c_easydrip, when: '초보자에게 장비 없이도 즐길 수 있는 선택지로 먼저 제시' },
    { label: '원두 주문 페이지',       url: PAGES.b2c_beans,    when: '원두로 넘어갈 준비가 됐을 때' },
  ],
  'b2c.taster': [
    { label: '원두 주문 페이지',       url: PAGES.b2c_beans,    when: '싱글 오리진/블렌드 추천 후 바로 주문 가능' },
  ],
  'b2c.gift': [
    { label: '이지드립 (드립백) 페이지', url: PAGES.b2c_easydrip, when: '선물용 드립백 세트 (10/20개입) 구성 가능' },
    { label: '원두 주문 페이지',       url: PAGES.b2c_beans,    when: '받는 분이 원두 파는 걸 선호하면' },
  ],
  'b2c.decaf': [
    { label: '원두 주문 페이지 (디카페인 필터)', url: PAGES.b2c_beans,    when: '디카페인 원두 구매' },
    { label: '이지드립 (디카페인 구성)',        url: PAGES.b2c_easydrip, when: '디카페인 드립백 선호 시' },
  ],

  // ========== B2B ==========
  'b2b.generic': [
    { label: 'B2B 원두 납품 주문 페이지', url: PAGES.b2b_order,  when: '도매 주문으로 넘어갈 때' },
    { label: 'B2B 무료 샘플 신청 페이지', url: PAGES.b2b_sample, when: '결정 전 샘플링이 필요할 때' },
  ],
  'b2b.opening': [
    { label: 'B2B 무료 샘플 신청 페이지', url: PAGES.b2b_sample, when: '오픈 전 원두 비교·선정용 샘플링에 최적' },
    { label: 'B2B 원두 납품 주문 페이지', url: PAGES.b2b_order,  when: '원두 확정 후 초도 주문' },
  ],
  'b2b.switching': [
    { label: 'B2B 무료 샘플 신청 페이지', url: PAGES.b2b_sample, when: '현 거래처 품질 비교용 샘플링 — 가장 먼저 안내' },
    { label: 'B2B 원두 납품 주문 페이지', url: PAGES.b2b_order,  when: '교체 결정 후 주문' },
  ],
  'b2b.office': [
    { label: 'B2B 원두 납품 주문 페이지', url: PAGES.b2b_order,  when: '정기 납품 견적' },
    { label: 'B2B 무료 샘플 신청 페이지', url: PAGES.b2b_sample, when: '구성원 테이스팅용 샘플' },
  ],
  'b2b.oem': [
    // OEM 은 페이지 안내보다 1:1 상담 우선. 그래도 레퍼런스로 샘플 페이지는 제공.
    { label: 'B2B 무료 샘플 신청 페이지', url: PAGES.b2b_sample, when: '레퍼런스 원두 테이스팅 원할 때' },
  ],
};

/**
 * 페르소나/서브 페르소나에 해당하는 링크 목록 반환.
 * 서브 페르소나가 없으면 generic 반환. 매칭 없으면 빈 배열.
 *
 * @param {string} persona    'b2c' | 'b2b' | 'unknown'
 * @param {string|null} subpersona  'b2c.decaf' 등
 * @returns {Array<{label: string, url: string, when: string}>}
 */
function getRelevantLinks(persona, subpersona) {
  if (subpersona && LINK_MAP[subpersona]) return LINK_MAP[subpersona];
  if (persona === 'b2b') return LINK_MAP['b2b.generic'];
  if (persona === 'b2c') return LINK_MAP['b2c.generic'];
  return [];
}

/**
 * 링크 목록을 프롬프트 주입용 마크다운 텍스트 블록으로 포맷.
 *
 * @param {Array<{label, url, when}>} links
 * @returns {string}
 */
function formatLinksForPrompt(links) {
  if (!links || links.length === 0) return '';
  const lines = links.map(l => `- **${l.label}** → ${l.url}\n  (안내 타이밍: ${l.when})`);
  return `【페이지 안내용 URL — 사용자 긍정 시에만 제시】
${lines.join('\n')}`;
}

module.exports = {
  PAGES,
  LINK_MAP,
  getRelevantLinks,
  formatLinksForPrompt,
};
