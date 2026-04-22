// lib/persona.js — B2C / B2B 페르소나 + 서브 페르소나 분류
//
// 출력 형태:
//   {
//     persona:        'b2b' | 'b2c' | 'unknown',
//     subpersona:     string | null,     // 주 서브 페르소나 (우선순위 1개)
//     subpersonaTags: string[],          // 감지된 모든 서브 태그 (analytics 용)
//     signals:        string[]           // 매치된 키워드 카테고리 (디버깅 용)
//   }
//
// 서브 페르소나 (총 8개):
//   B2B
//     - 'b2b.oem'      : OEM·PB·호텔 어메니티·구독 큐레이션 → **즉시 휴먼 에스컬레이션**
//     - 'b2b.opening'  : 예비 창업자 (오픈 준비, 샘플 신청, 바리스타 교육 문의)
//     - 'b2b.switching': 기존 사장 거래처 교체 (납기 불만, 현재 쓰던, 바꾸려고)
//     - 'b2b.office'   : 사무실·법인 복지 (탕비실, 구내, 스터디카페, 월정기)
//   B2C
//     - 'b2c.decaf'    : 디카페인 / 임산부 / 수면 민감 (product constraint)
//     - 'b2c.gift'     : 선물 구매자 (어버이날, 생신, 포장, 지정일)
//     - 'b2c.taster'   : 취향 탐구자 (싱글 오리진, 프로세스, 커핑노트)
//     - 'b2c.beginner' : 홈카페 초보 (처음, 잘 모르는데, 꼬소한/고소한)
//
// 우선순위 (여러 서브가 동시에 매치될 때 1개만 주 페르소나로):
//   B2B: oem > opening > switching > office
//   B2C: decaf > gift > taster > beginner
//
// 전체 페르소나 (b2b/b2c):
//   - B2B 신호 하나라도 있으면 B2B (sticky — 과거 대화 전체 스캔)
//   - B2B 가 아니고 B2C 신호 있으면 B2C
//   - 아무 신호도 없으면 'unknown'

// ===========================================================================
// 서브 페르소나별 패턴 그룹
// ===========================================================================

// -- B2B : OEM / PB / 호텔 어메니티 / 구독 큐레이션 ---------------------------
const B2B_OEM_PATTERNS = [
  /\bOEM\b/i,
  /\bODM\b/i,
  /\bPB\b/i,
  /프라이빗\s*라벨/i,
  /자체\s*브랜드|자사\s*브랜드/i,
  /커스텀\s*패키지|패키지\s*커스텀|라벨\s*디자인/i,
  /호텔\s*(어메니티|납품)|호텔\s*객실/i,
  /백화점\s*(납품|입점)/i,
  /구독\s*(큐레이션|서비스)\s*(운영|기획)/i,  // "내가 구독 서비스 운영" 맥락만
  /\b바이어\b|\bMD\b/i,
  /연간\s*계약|독점\s*공급|연간\s*공급/i,
];

// -- B2B : 예비 창업자 -------------------------------------------------------
const B2B_OPENING_PATTERNS = [
  /창업(준비|예정)?/i,
  /(카페|로스터리|매장)\s*(오픈|차리|개업)/i,
  /오픈\s*예정/i,
  /예비\s*창업/i,
  /신규\s*(매장|거래|지점)/i,
  /샘플\s*(신청|요청|문의|받아|가능)/i,
  /바리스타\s*교육|추출\s*교육|트레이닝/i,
  /컨설팅|메뉴\s*개발|시그니처\s*메뉴/i,
  /(에스프레소|드립|시그니처|하우스)\s*블렌드\s*(추천|문의|선정|고민)/i,
  /상호|매장\s*명|매장\s*주소|오픈\s*일정/i,
];

// -- B2B : 기존 사장 거래처 교체 ---------------------------------------------
const B2B_SWITCHING_PATTERNS = [
  /거래처|납품업체|공급처/i,
  /(바꾸|교체|변경)\s*(하려|하고|예정)/i,
  /대체(재|할)?/i,
  /현재\s*쓰(고|던)|지금\s*쓰(고|던)|지금\s*거래/i,
  /납기\s*(늦|지연|불안)/i,
  /품질\s*(편차|문제|불만)/i,
  /가격\s*인상/i,
  /배치(별)?\s*편차/i,
  /단가\s*비교/i,
];

// -- B2B : 사무실 / 법인 / 구내 -----------------------------------------------
const B2B_OFFICE_PATTERNS = [
  /사무실|회사|법인/i,
  /탕비실|복지|총무|인사팀/i,
  /(사내|구내)\s*(카페|커피|커피머신|식당)/i,
  /스터디\s*카페|스터디카페/i,
  /(월|매월)\s*정기\s*(납품|배송|공급)/i,
  /자동\s*발주/i,
  /\d{1,3}\s*명\s*(사무실|회사|임직원|팀)/i,
];

// -- B2B : 일반 신호 (서브 미매치지만 B2B 로 분류) -----------------------------
// OEM/창업/교체/오피스 모두 miss 했지만 "도매", "납품", "세금계산서" 같은
// B2B 진단 언어가 등장한 경우 — 서브는 null, persona 만 'b2b'.
const B2B_GENERIC_PATTERNS = [
  /도매/i,
  /납품/i,
  /벌크/i,
  /대량\s*(주문|구매|구입|매입)/i,
  /사업자(등록증|번호)?/i,
  /세금\s*계산서/i,
  /세금계산서/i,
  /후불|선입금|월말\s*결제|견적서/i,
  /(?:[5-9]|[1-9]\d+)\s*(?:kg|키로|킬로|킬로그램)/i,  // 5-9kg, 10kg+, 50kg, 100kg…
  /월\s*\d+\s*(kg|키로|킬로)/i,                       // 월 10kg…
  /\bMOQ\b|최소\s*주문\s*수량|최소주문/i,
  /프랜차이즈\s*(본사|가맹점)|가맹\s*계약/i,
  /\bB2B\b/i,
];

// -- B2C : 디카페인 / 임산부 --------------------------------------------------
const B2C_DECAF_PATTERNS = [
  /디카페인|디카프/i,
  /decaf/i,
  /카페인\s*(없는|적은|제로|프리)/i,
  /임산부|임신(\s*중)?/i,
  /수유(\s*중)?/i,
  /수면\s*(민감|방해)|잠\s*안\s*와/i,
  /스위스\s*워터|CO2\s*(공법|디카페인)/i,
];

// -- B2C : 선물 구매자 -------------------------------------------------------
const B2C_GIFT_PATTERNS = [
  /선물/i,
  /기프트\b|기프트세트|기프트\s*세트/i,
  /부모님|어머니|어머님|아버지|아버님/i,
  /어버이날|스승의\s*날/i,
  /생신|생일\s*선물/i,
  /명절|추석|설|한가위/i,
  /포장|쇼핑백|카드\s*동봉|편지|쪽지/i,
  /지정일\s*배송|날짜\s*지정/i,
  /예쁘게\s*포장|예쁜\s*포장/i,
];

// -- B2C : 취향 탐구자 (스페셜티 덕후) -----------------------------------------
const B2C_TASTER_PATTERNS = [
  /싱글\s*오리진|싱글오리진/i,
  /예가체프|시다모|코케|아리차/i,
  /게이샤|버번|SL28|티피카|카투라/i,
  /마이크로\s*랏|마이크로랏/i,
  /내추럴|워시드|허니\s*프로세스|허니\s*가공|아네로빅|무산소/i,
  /커핑\s*노트|커핑노트|플레이버\s*노트/i,
  /\bSCA\b|\bSCAA\b/i,
  /로스팅\s*(일자|날짜|포인트|프로파일)/i,
  /디벨롭(먼트)?|develop/i,
  /V60|칼리타|하리오|케멕스|오리가미|에어로프레스|모카포트/i,
];

// -- B2C : 홈카페 초보 -------------------------------------------------------
const B2C_BEGINNER_PATTERNS = [
  /처음\s*[가-힣]{0,3}(사|마|먹|드|써|해|내|구매|구입)/i,
  /입문|뉴비|초보/i,
  /잘\s*모르(는데|겠|겠어)/i,
  /(꼬소한|고소한|달달한|부드러운|마시기\s*편한)/i,
  /쓴맛\s*(싫|없는|안)/i,
  /신맛\s*(싫|없는|안)/i,
  /어떤\s*맛|무슨\s*맛/i,
  /200\s*g|한\s*봉지?|소용량/i,
  /홀빈|분쇄|그라인더\s*없(어|는)/i,
];

// -- B2C : 일반 신호 (서브 미매치지만 B2C 로 분류) -----------------------------
const B2C_GENERIC_PATTERNS = [
  /홈카페/i,
  /집에서\s*[가-힣]{0,3}(마|먹|드|내)/i,   // 집에서 마실/먹을/드실/내려
  /(혼자|혼자서)\s*마시/i,
  /드립백|이지드립/i,
  /취향/i,
  /한\s*봉지?/i,
];


// ===========================================================================
// 매처
// ===========================================================================

function matchAny(text, patterns) {
  if (!text) return false;
  return patterns.some((re) => re.test(text));
}

// 주어진 텍스트에서 서브 페르소나 태그를 전부 감지.
// 반환: ['b2b.oem', 'b2b.opening'] 등 (중복 없이).
function detectAllSubTags(text) {
  const tags = [];
  // B2B
  if (matchAny(text, B2B_OEM_PATTERNS))       tags.push('b2b.oem');
  if (matchAny(text, B2B_OPENING_PATTERNS))   tags.push('b2b.opening');
  if (matchAny(text, B2B_SWITCHING_PATTERNS)) tags.push('b2b.switching');
  if (matchAny(text, B2B_OFFICE_PATTERNS))    tags.push('b2b.office');
  // B2C
  if (matchAny(text, B2C_DECAF_PATTERNS))    tags.push('b2c.decaf');
  if (matchAny(text, B2C_GIFT_PATTERNS))     tags.push('b2c.gift');
  if (matchAny(text, B2C_TASTER_PATTERNS))   tags.push('b2c.taster');
  if (matchAny(text, B2C_BEGINNER_PATTERNS)) tags.push('b2c.beginner');
  return tags;
}

// 우선순위 기반 주 서브 페르소나 선정
const B2B_PRIORITY = ['b2b.oem', 'b2b.opening', 'b2b.switching', 'b2b.office'];
const B2C_PRIORITY = ['b2c.decaf', 'b2c.gift', 'b2c.taster', 'b2c.beginner'];

function pickPrimary(tags, priority) {
  for (const p of priority) {
    if (tags.includes(p)) return p;
  }
  return null;
}


/**
 * 전체 대화 히스토리 + 이번 턴의 user 메시지를 보고 페르소나 판정.
 * @param {Array<{role:string, content:string}>} history
 * @param {string} currentMessage
 * @returns {{persona:string, subpersona:string|null, subpersonaTags:string[], signals:string[]}}
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

  const tags = detectAllSubTags(joined);
  const b2bTags = tags.filter((t) => t.startsWith('b2b.'));
  const b2cTags = tags.filter((t) => t.startsWith('b2c.'));

  const signals = [];
  let persona = 'unknown';
  let subpersona = null;

  // B2B 우선 — sub 가 감지됐거나 generic B2B 신호가 있으면 b2b
  if (b2bTags.length > 0 || matchAny(joined, B2B_GENERIC_PATTERNS)) {
    persona = 'b2b';
    subpersona = pickPrimary(b2bTags, B2B_PRIORITY);  // null 일 수도
    if (b2bTags.length > 0) signals.push('b2b-sub:' + b2bTags.join(','));
    if (matchAny(joined, B2B_GENERIC_PATTERNS)) signals.push('b2b-generic');
  } else if (b2cTags.length > 0 || matchAny(joined, B2C_GENERIC_PATTERNS)) {
    persona = 'b2c';
    subpersona = pickPrimary(b2cTags, B2C_PRIORITY);
    if (b2cTags.length > 0) signals.push('b2c-sub:' + b2cTags.join(','));
    if (matchAny(joined, B2C_GENERIC_PATTERNS)) signals.push('b2c-generic');
  }

  return {
    persona,
    subpersona,
    subpersonaTags: tags,
    signals,
  };
}

// 구 인터페이스 유지 (routes/chat.js 가 import 하는 `classify`).
// 단일 메시지만 받아 persona 문자열 반환 — 기존 호출자 호환.
function classify(firstUserMessage) {
  return classifyFromHistory([], firstUserMessage || '').persona;
}

module.exports = {
  classify,
  classifyFromHistory,
  // 테스트 / 분석 노출
  _PATTERNS: {
    B2B_OEM_PATTERNS,
    B2B_OPENING_PATTERNS,
    B2B_SWITCHING_PATTERNS,
    B2B_OFFICE_PATTERNS,
    B2B_GENERIC_PATTERNS,
    B2C_DECAF_PATTERNS,
    B2C_GIFT_PATTERNS,
    B2C_TASTER_PATTERNS,
    B2C_BEGINNER_PATTERNS,
    B2C_GENERIC_PATTERNS,
  },
};
