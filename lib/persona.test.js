// lib/persona.test.js — 서브 페르소나 분류 단위 테스트
//
// 실행: node lib/persona.test.js
//
// 각 케이스는 [label, history, currentMessage, expectedPersona, expectedSub] 튜플.
// expectedSub 가 undefined 이면 sub 는 검증하지 않음 (persona 만 체크).

const assert = require('node:assert');
const { classifyFromHistory, classify } = require('./persona');

const cases = [
  // ===== 첫 턴 — unknown =====
  ['empty first turn',               [], '', 'unknown', null],
  ['완전 neutral',                   [], '안녕하세요', 'unknown', null],

  // ===== B2C.beginner =====
  ['beginner: 처음',                 [], '원두 처음 사요', 'b2c', 'b2c.beginner'],
  ['beginner: 잘 모르는데',           [], '커피 잘 모르는데 추천해주세요', 'b2c', 'b2c.beginner'],
  ['beginner: 고소한',               [], '고소한 원두 있나요?', 'b2c', 'b2c.beginner'],
  ['beginner: 꼬소한 (방언)',         [], '꼬소한 거 추천해주세요', 'b2c', 'b2c.beginner'],
  ['beginner: 쓴맛 싫어요',           [], '쓴맛 싫어요 부드러운 거로', 'b2c', 'b2c.beginner'],
  ['beginner: 200g',                 [], '200g 한 봉지 얼마예요', 'b2c', 'b2c.beginner'],
  // "집에서 마실" alone only hits generic B2C — no sub. Pair with "처음" or "잘 모르는데" to trigger beginner.
  ['generic b2c: 집에서 마실',        [], '집에서 마실 원두 추천', 'b2c', null],
  ['beginner + 집에서',               [], '집에서 처음 마실 원두 추천', 'b2c', 'b2c.beginner'],

  // ===== B2C.taster =====
  ['taster: 싱글 오리진',             [], '싱글 오리진 중에 뭐가 좋나요?', 'b2c', 'b2c.taster'],
  ['taster: 게이샤',                 [], '게이샤 들어올 계획 있나요?', 'b2c', 'b2c.taster'],
  ['taster: 내추럴',                 [], '내추럴 프로세스 좋아해요', 'b2c', 'b2c.taster'],
  ['taster: 커핑노트',               [], '커핑노트 공유해주실 수 있나요?', 'b2c', 'b2c.taster'],
  ['taster: V60',                    [], 'V60 용으로 추천 부탁드려요', 'b2c', 'b2c.taster'],
  ['taster: 예가체프',               [], '예가체프 워시드 재고 있어요?', 'b2c', 'b2c.taster'],

  // ===== B2C.gift =====
  ['gift: 선물용',                   [], '선물용으로 사려고요', 'b2c', 'b2c.gift'],
  ['gift: 어버이날',                 [], '어버이날 부모님 선물', 'b2c', 'b2c.gift'],
  ['gift: 생신',                     [], '아버지 생신 선물인데', 'b2c', 'b2c.gift'],
  ['gift: 포장',                     [], '예쁘게 포장해주세요', 'b2c', 'b2c.gift'],
  ['gift: 기프트세트',                [], '기프트세트 구성 알려주세요', 'b2c', 'b2c.gift'],

  // ===== B2C.decaf =====
  ['decaf: 디카페인',                [], '디카페인 있나요?', 'b2c', 'b2c.decaf'],
  ['decaf: 임산부',                  [], '임산부인데 마실 수 있는 원두', 'b2c', 'b2c.decaf'],
  ['decaf: 수면 민감',                [], '수면에 민감해서 카페인 적은 거', 'b2c', 'b2c.decaf'],
  ['decaf: 스위스워터',               [], '스위스 워터 공법 쓰세요?', 'b2c', 'b2c.decaf'],

  // ===== B2B.oem =====
  ['oem: OEM 직접',                  [], 'OEM 가능한가요?', 'b2b', 'b2b.oem'],
  ['oem: PB',                        [], 'PB 상품 만들고 싶은데', 'b2b', 'b2b.oem'],
  ['oem: 자사 브랜드',                [], '자사 브랜드로 패키지 제작하고 싶어요', 'b2b', 'b2b.oem'],
  ['oem: 호텔 어메니티',              [], '호텔 어메니티용 원두 필요한데요', 'b2b', 'b2b.oem'],
  ['oem: 구독 큐레이션',              [], '구독 서비스 운영하는데 큐레이션 파트너 찾아요', 'b2b', 'b2b.oem'],

  // ===== B2B.opening =====
  ['opening: 창업준비',               [], '카페 창업 준비 중입니다', 'b2b', 'b2b.opening'],
  ['opening: 오픈 예정',              [], '3월에 매장 오픈 예정이에요', 'b2b', 'b2b.opening'],
  ['opening: 샘플 신청',              [], '샘플 신청 가능한가요', 'b2b', 'b2b.opening'],
  ['opening: 바리스타 교육',           [], '바리스타 교육도 지원되나요?', 'b2b', 'b2b.opening'],
  ['opening: 시그니처 메뉴',          [], '시그니처 메뉴 개발 도와주시나요', 'b2b', 'b2b.opening'],

  // ===== B2B.switching =====
  ['switching: 거래처 교체',           [], '거래처 교체 고려 중입니다', 'b2b', 'b2b.switching'],
  ['switching: 현재 쓰는',             [], '현재 쓰고 있는 원두랑 비교 가능한가요?', 'b2b', 'b2b.switching'],
  ['switching: 납기 지연',            [], '지금 거래처 납기가 자꾸 지연돼서요', 'b2b', 'b2b.switching'],
  ['switching: 단가 비교',            [], '단가 비교 좀 해보려고 합니다', 'b2b', 'b2b.switching'],

  // ===== B2B.office =====
  ['office: 사무실',                  [], '사무실 탕비실용 원두 납품 가능한가요?', 'b2b', 'b2b.office'],
  ['office: 구내카페',                [], '구내 카페용으로 매월 정기 납품', 'b2b', 'b2b.office'],
  ['office: 스터디카페',              [], '스터디카페 운영하는데 납품받고 싶어요', 'b2b', 'b2b.office'],
  ['office: 30명 사무실',             [], '30명 사무실인데 월 몇 kg 필요할까요', 'b2b', 'b2b.office'],

  // ===== B2B generic (sub 없이 persona만) =====
  ['generic b2b: 도매',               [], '도매 가격 알려주세요', 'b2b', null],
  ['generic b2b: 세금계산서',          [], '세금계산서 발행되나요?', 'b2b', null],
  ['generic b2b: 10kg',               [], '10kg 단위 주문 가능한가요', 'b2b', null],

  // ===== Sticky (히스토리 스캔) =====
  [
    'sticky b2b: 첫 턴 OEM 이후 맛 질문',
    [
      { role: 'user', content: 'OEM 가능한가요?' },
      { role: 'assistant', content: '...' },
    ],
    '그런데 어떤 맛이 인기가 많아요?',
    'b2b', 'b2b.oem',
  ],
  [
    'sticky b2c.gift: 선물 이후 드립백 질문',
    [
      { role: 'user', content: '어버이날 선물용이요' },
      { role: 'assistant', content: '...' },
    ],
    '드립백 세트도 있나요',
    'b2c', 'b2c.gift',
  ],
  [
    'sticky priority: decaf > gift',
    [
      { role: 'user', content: '선물용으로 사려는데' },
      { role: 'assistant', content: '...' },
    ],
    '디카페인으로 부탁드려요 받는 분이 임산부라',
    'b2c', 'b2c.decaf',  // decaf 우선순위 더 높음
  ],
  [
    'sticky priority: oem > opening (both match)',
    [
      { role: 'user', content: '카페 오픈 예정인데' },
      { role: 'assistant', content: '...' },
    ],
    'OEM으로 자체 브랜드 만들려고요',
    'b2b', 'b2b.oem',  // oem 우선순위 최상
  ],

  // ===== False-positive 방지 =====
  [
    'false-pos: 카페에서 마셨는데 (cafe visit, not b2b)',
    [], '카페에서 마셨는데 비슷한 맛 있나요', 'unknown', null,
  ],
  [
    'false-pos: 구독 서비스는 없나요 (구매자 구독, not OEM 운영)',
    [], '구독 서비스는 없나요?', 'unknown', null,
  ],

  // ===== 구 인터페이스 (classify) =====
];

let pass = 0, fail = 0;

for (const [label, history, msg, expP, expS] of cases) {
  const got = classifyFromHistory(history, msg);
  const okP = got.persona === expP;
  const okS = (expS === undefined) ? true : (got.subpersona === expS);
  if (okP && okS) {
    pass++;
  } else {
    fail++;
    console.log(`✗ ${label}`);
    console.log(`  msg: ${JSON.stringify(msg)}`);
    console.log(`  exp: persona=${expP} sub=${expS}`);
    console.log(`  got: persona=${got.persona} sub=${got.subpersona} tags=[${got.subpersonaTags.join(',')}]`);
  }
}

// 구 인터페이스 호환 체크
{
  const oldCall = classify('디카페인 있나요');
  if (oldCall === 'b2c') pass++;
  else { fail++; console.log(`✗ classify() back-compat: got ${oldCall}, want b2c`); }
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
process.exit(fail === 0 ? 0 : 1);
