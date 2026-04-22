// lib/catalog.js — data/catalog.json 을 페르소나 맞춤 텍스트 블록으로 포맷
//
// 외부 진입점:
//   getCatalog()                           → raw JSON
//   formatCatalogForPersona(persona, sub)  → 시스템 프롬프트에 주입할 텍스트 블록
//
// 설계 원칙:
// - catalog.json 에 있는 **팩트만** 포맷 (환각 방지)
// - 페르소나에 맞는 슬라이스만 전달 (토큰 절약)
//   · B2C → 원두 10종 + B2C 주문 옵션 + 이지드립
//   · B2B → 원두 10종 + B2B MOQ/샘플/사이즈 + 커스텀 블렌드
// - 링크/URL 은 별도 (lib/links.js) 관리. 카탈로그는 **데이터만**.

const catalog = require('../data/catalog.json');

function getCatalog() {
  return catalog;
}

// ---- 원두 리스트 포맷 ----

function formatBean(b) {
  const parts = [
    `- ${b.name_ko} (${b.name_en})`,
  ];
  const sub = [];
  if (b.roast)  sub.push(`로스팅: ${b.roast}`);
  if (b.origin) sub.push(`원산지: ${b.origin}`);
  sub.push(`카테고리: ${flavorLabel(b.flavor)}`);
  if (b.reference_price_1kg_krw) {
    sub.push(`참고 단가: ${b.reference_price_1kg_krw.toLocaleString('ko-KR')}원/1kg`);
  }
  parts.push('  ' + sub.join(' · '));
  if (b.notes) parts.push(`  노트: ${b.notes}`);
  if (b.recommend_for && b.recommend_for.length) {
    parts.push(`  추천: ${b.recommend_for.join(', ')}`);
  }
  return parts.join('\n');
}

function flavorLabel(id) {
  const fc = catalog.flavor_categories.find(c => c.id === id);
  return fc ? fc.name : id;
}

function formatBeansSection() {
  const blends = catalog.beans.filter(b => b.type === 'blend');
  const singles = catalog.beans.filter(b => b.type === 'single');
  const decafs = catalog.beans.filter(b => b.type === 'decaf');

  return [
    '=== 판매 중인 원두 (총 ' + catalog.beans.length + '종 + 커스텀 블렌드) ===',
    '',
    '【블렌드 ' + blends.length + '종】',
    blends.map(formatBean).join('\n\n'),
    '',
    '【싱글 오리진 ' + singles.length + '종】',
    singles.map(formatBean).join('\n\n'),
    '',
    '【디카페인 ' + decafs.length + '종】',
    decafs.map(formatBean).join('\n\n'),
    '',
    catalog.custom_blend && catalog.custom_blend.available
      ? '【커스텀 블렌드】 ' + (catalog.custom_blend.note || '')
      : '',
  ].filter(Boolean).join('\n');
}

// ---- B2C 섹션 ----

function formatB2COrderSection() {
  const b = catalog.b2c_order;
  const weights = b.weight_options.map(w => {
    const note = w.note ? ` (${w.note})` : '';
    return `${w.size} (~${w.cups_approx}잔)${note}`;
  }).join(', ');

  return [
    '=== B2C 원두 주문 옵션 ===',
    `- 주문 방식: ${b.ordering_model}`,
    `- 중량: ${weights}`,
    `- 분쇄도: ${b.grind_options.join(', ')}`,
    `- 로스팅 옵션:`,
    ...b.roast_options.map(r => `  · ${r.name} — ${r.notes}`),
  ].join('\n');
}

function formatEasydripSection() {
  const e = catalog.easydrip;
  return [
    '=== 이지드립 (드립백) ===',
    `- 1개당 ${e.weight_per_bag_g}g, ${e.packaging}`,
    `- 구성 옵션: ${e.compositions.map(c => `${c.name}(${c.notes})`).join(', ')}`,
    `- 패키지: ${e.pack_sizes.map(p => {
      const d = p.discount_pct ? ` (${p.discount_pct}% 할인)` : '';
      return `${p.count}${d}`;
    }).join(', ')}`,
  ].join('\n');
}

// ---- B2B 섹션 ----

function formatB2BSection() {
  const b = catalog.b2b;
  const s = b.sample_program;
  const sizeLines = b.sizes.map(sz => `  · ${sz.size} — ${sz.purpose}`);

  return [
    '=== B2B (도매·납품) 조건 — 페이지 기준 실제 정책 ===',
    `- **최소 주문 (MOQ): ${b.moq.total_kg}kg 이상** (${b.moq.combos.join(' 또는 ')})`,
    `- 포장 단위:`,
    ...sizeLines,
    `- 가격: ${b.pricing}`,
    `- 세금계산서: ${b.tax_invoice}`,
    `- 자격: ${b.eligibility}`,
    '',
    '【무료 샘플 프로그램 — 반드시 이 스펙만 안내】',
    `- 샘플 무게: **${s.weight_g}g** (${s.cost}, 최대 ${s.max_varieties}종 선택)`,
    `- 발송 시점: 승인 후 영업일 ${s.lead_time_days_after_approval}일 이내`,
    `- 담당자 연락: ${s.confirmation_time_biz_days}`,
    `- 필요 서류: ${s.docs_required.join(', ')}`,
    `- 신청 폼 항목: ${s.form_fields.join(', ')}`,
  ].join('\n');
}

// ---- 맛 카테고리 ----

function formatFlavorCategories() {
  return [
    '=== 맛 카테고리 (오라운트 공식 분류) ===',
    ...catalog.flavor_categories.map(c => `- ${c.name}: ${c.notes}`),
  ].join('\n');
}

// ---- 브랜드 ----

function formatBrandSection() {
  const b = catalog.brand;
  return [
    '=== 브랜드 정보 ===',
    `- ${b.name_ko} (${b.name_en}) — ${b.tagline}`,
    `- 주소: ${b.address}`,
    `- 연락처: ${b.phone} / ${b.email}`,
    `- 영업시간: ${b.hours}`,
    `- 납품 레퍼런스: ${b.case_studies.join(', ')}`,
  ].join('\n');
}

// ---- 공개 API: 페르소나별 슬라이스 ----

/**
 * 페르소나에 맞는 카탈로그 텍스트 블록 반환 (시스템 프롬프트 주입용)
 *
 * @param {string} persona  'b2c' | 'b2b' | 'unknown'
 * @param {string|null} subpersona  (현재 미사용, 향후 확장용)
 * @returns {string}
 */
function formatCatalogForPersona(persona, subpersona) {
  const parts = [
    formatBrandSection(),
    '',
    formatFlavorCategories(),
    '',
    formatBeansSection(),
    '',
  ];

  if (persona === 'b2b') {
    parts.push(formatB2BSection());
  } else {
    parts.push(formatB2COrderSection());
    parts.push('');
    parts.push(formatEasydripSection());
  }

  return parts.join('\n');
}

module.exports = {
  getCatalog,
  formatCatalogForPersona,
  // 테스트/디버그용
  formatBeansSection,
  formatB2BSection,
  formatB2COrderSection,
  formatEasydripSection,
  formatBrandSection,
  formatFlavorCategories,
};
