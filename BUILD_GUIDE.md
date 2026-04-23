# ORAUND AI Chatbot — Build Guide

> 스페셜티 커피 로스터리 **오라운트(ORAUND)** 의 AI 상담 챗봇.
> Claude(Anthropic) 기반, Cafe24 프론트 + Railway Node.js 백엔드 + Postgres 로그 +
> SMTP 이메일 연동. 이 문서 하나로 다른 브랜드·다른 도메인에 동일한 구조를
> 복제할 수 있도록 작성됐다.

---

## 목차

1. [무엇을 만든 건지](#1-무엇을-만든-건지)
2. [기술 스택 & 운영 비용](#2-기술-스택--운영-비용)
3. [아키텍처 한 장](#3-아키텍처-한-장)
4. [저장소 구조](#4-저장소-구조)
5. [요청 흐름 (턴 단위)](#5-요청-흐름-턴-단위)
6. [핵심 컴포넌트](#6-핵심-컴포넌트)
   - 6.1 페르소나 분류기
   - 6.2 모델 라우팅 (Haiku vs Sonnet)
   - 6.3 카탈로그 그라운딩 (환각 방지)
   - 6.4 페이지 안내 플로우
   - 6.5 불만족 신호 탐지
   - 6.6 세션·PIPA 해시
7. [데이터베이스 스키마](#7-데이터베이스-스키마)
8. [이메일(상담 요청) 시스템](#8-이메일상담-요청-시스템)
9. [프론트엔드 위젯](#9-프론트엔드-위젯)
10. [Railway 배포](#10-railway-배포)
11. [환경변수 레퍼런스](#11-환경변수-레퍼런스)
12. [로컬 개발](#12-로컬-개발)
13. [다른 브랜드로 복제하는 법 — 체크리스트](#13-다른-브랜드로-복제하는-법--체크리스트)
14. [자주 마주치는 이슈](#14-자주-마주치는-이슈)

---

## 1. 무엇을 만든 건지

- **공개 쇼핑몰 페이지** (Cafe24 호스팅, `oraund.com`) 에 떠 있는 **AI 챗봇**
- **두 종류의 고객** 을 동시에 응대:
  - **B2C** — 홈카페, 선물, 입문자, 디카페인 수요
  - **B2B** — 카페 사장 (개업 준비·거래처 교체·사무실 납품·OEM)
- **상담으로의 브릿지**: 대화 하단 "위 대화 내용으로 상담 요청하기" 버튼 →
  폼 제출 → 대화 전체가 이메일로 영업팀에 배달
- **매출로 직결되지 않는 질문**(핸드드립 내리는 법, 보관법 등)도 친절히 답변
  → 재방문 고객 확보

핵심 설계 결정:

- **응답 속도가 UX의 전부** → 첫 턴은 무조건 빠른 모델(Haiku), B2B 확인된 뒤에만 큰 모델(Sonnet)로 승격
- **AI가 지어내면 브랜드가 망가진다** → 모든 수치(샘플 무게·MOQ·제품명·가격)를 실제 페이지에서 스크래핑한 `data/catalog.json` 에 박아두고 프롬프트에 주입
- **링크는 권유, 강요 아님** → AI가 먼저 *"페이지 보여드릴까요?"* 묻고, 사용자가 "네" 한 다음 턴에 URL 제시

---

## 2. 기술 스택 & 운영 비용

| 계층 | 쓰는 기술 | 왜 |
|---|---|---|
| 프론트 호스팅 | **Cafe24 스킨** (`oraund.com`) | 기존 쇼핑몰 도메인 그대로. 쿠키·세션 충돌 없음. |
| 챗봇 위젯 | `public/oraund-chat.js` (vanilla JS, 651줄) | Cafe24 스킨에 `<script src>` 한 줄로 삽입. 빌드 없음. |
| 백엔드 런타임 | **Node.js + Express** | 간결. 팀에 JS 익숙한 사람 많음. |
| 백엔드 호스팅 | **Railway** (GitHub → auto-deploy) | `git push` 만 하면 배포. Postgres 내장. |
| LLM | **Anthropic Claude** (`@anthropic-ai/sdk`) | Haiku 4.5 / Sonnet 4 두 모델 병행. 한국어 품질·지시 따름 최상. |
| DB | **Postgres** (Railway) | 대화 로그·상담 요청 저장. 선택사항 (DATABASE_URL 없으면 자동 비활성). |
| 이메일 | **Nodemailer + SMTP** (Gmail/Naver/Sendgrid 등) | 상담 요청을 영업팀 메일로 전달. |

대략적 월 운영비 (실사용량 작을 때):
- Railway Hobby: $5/월 (Node 앱 + Postgres 공유)
- Anthropic API: 사용량 기반 — 하루 대화 100건 기준 $1-3/월 예상
- SMTP: Gmail/Naver 개인 계정은 **무료** (앱 비밀번호 사용)
- 총 **약 월 $6-10 수준** 에서 시작 가능

---

## 3. 아키텍처 한 장

```
┌──────────────────────────────────────────────────────────────────┐
│   브라우저 (오라운트 쇼핑몰 사용자)                                │
│   https://oraund.com/*.html                                      │
│                                                                  │
│   <script src="https://<railway-domain>/oraund-chat.js">         │
│                  │                                               │
│                  ▼                                               │
│   #aiPanel (modal)  ←→  sessionStorage: oraund_chat_session      │
│   #chatInput / #chatMessages                                     │
│   "위 대화 내용으로 상담 요청하기" 버튼                           │
└──────────────────────────────────────────────────────────────────┘
            │  POST /api/chat     (매 턴)
            │  POST /api/consult  (상담 폼 제출)
            ▼
┌──────────────────────────────────────────────────────────────────┐
│   Railway (Node.js)                                              │
│                                                                  │
│   server.js ─ express app                                        │
│    │                                                             │
│    ├─ GET  /health                                               │
│    ├─ GET  /oraund-chat.js  (static, 5분 캐시)                   │
│    │                                                             │
│    ├─ POST /api/chat                                             │
│    │   routes/chat.js                                            │
│    │     1. 첫 턴? → Haiku + B2C 프롬프트                        │
│    │     2. 이후 턴? lib/persona.classifyFromHistory() 호출      │
│    │        → b2b.* → Sonnet + B2B 프롬프트 + 서브 힌트          │
│    │        → b2c.* → Haiku  + B2C 프롬프트 + 서브 힌트          │
│    │     3. prompts/buildSystemPrompt(persona, sub)              │
│    │        └─ lib/catalog.js  (data/catalog.json 기반)          │
│    │        └─ lib/links.js    (페르소나→URL 큐레이션)           │
│    │     4. Anthropic.messages.create({ model, system, messages })│
│    │     5. lib/dissatisfaction.detectAll() → flags              │
│    │     6. chat_log INSERT (user+assistant 각 1행)              │
│    │                                                             │
│    └─ POST /api/consult                                          │
│        routes/consult.js                                         │
│          1. consultation_request INSERT (전체 대화 스냅샷)        │
│          2. Nodemailer → CONSULT_TO (영업팀 메일)                │
│          3. email_sent=true 로 UPDATE                            │
└──────────────────────────────────────────────────────────────────┘
            │                      │
            ▼                      ▼
   ┌──────────────────┐   ┌──────────────────┐
   │  Postgres        │   │  SMTP (Gmail/등) │
   │  (Railway addon) │   │  info@oraund.com │
   │                  │   │  bywockd@gmail   │
   │  chat_log        │   └──────────────────┘
   │  consultation_*  │
   │  _migrations     │
   └──────────────────┘
```

---

## 4. 저장소 구조

```
oraund-backend/
├── server.js                      ← Express 부트스트랩 + 정적 서빙
├── db.js                          ← Postgres 풀 + 자동 마이그레이션
├── package.json
│
├── routes/
│   ├── chat.js                    ← POST /api/chat (라우팅·로깅·불만족 탐지)
│   └── consult.js                 ← POST /api/consult (상담 요청·메일 발송)
│
├── lib/
│   ├── persona.js                 ← 8-way 페르소나 분류기 (히스토리 기반)
│   ├── persona.test.js            ← 53개 테스트 케이스
│   ├── catalog.js                 ← 페르소나별 카탈로그 슬라이스 포맷터
│   ├── links.js                   ← 서브 페르소나 → URL 큐레이션
│   └── dissatisfaction.js         ← 6종 불만족 신호 탐지
│
├── prompts/
│   └── index.js                   ← buildSystemPrompt() — B2C/B2B 조립
│
├── data/
│   └── catalog.json               ← 4페이지에서 스크래핑한 실제 제품 데이터
│
├── migrations/
│   └── 001_chat_log.sql           ← chat_log + consultation_request 스키마
│
└── public/
    └── oraund-chat.js             ← 브라우저 위젯 (Cafe24에서 <script>로 로드)
```

---

## 5. 요청 흐름 (턴 단위)

브라우저에서 사용자가 메시지를 보내면:

```
[1] POST /api/chat  body: { message, history, sessionId }
       │
       ▼
[2] routes/chat.js : routeRequest(history, message)
       │   - 첫 턴? → { model: HAIKU, system: B2C_PROMPT, persona: 'unknown' }
       │   - 아니면? → persona.classifyFromHistory() 호출
       │     - history + currentMessage 를 스캔해서 가장 높은 우선순위 서브 페르소나 반환
       │
       ▼
[3] prompts.buildSystemPrompt(persona, subpersona)
       │   - lib/catalog.formatCatalogForPersona(persona) 로 제품 데이터 주입
       │   - lib/links.getRelevantLinks(persona, sub)   로 URL 블록 주입
       │   - SUBPERSONA_HINTS[sub] 로 서브 힌트 블록 주입
       │   - PAGE_GUIDANCE_RULE + 환각 방지 규칙 주입
       │
       ▼
[4] chat_log INSERT (role='user', persona, flags.subpersona, ip_hash, ...)
       │
       ▼
[5] anthropic.messages.create({ model, max_tokens: 500, system, messages })
       │   - HAIKU = claude-haiku-4-5
       │   - SONNET = claude-sonnet-4-20250514
       │
       ▼
[6] lib/dissatisfaction.detectAll({ userMsg, assistantMsg, prevUserMsgs })
       │   - 6종 신호: 반복 질문·감정 격화·"모르겠어요"·불만 키워드·AI 회피·세션 길이
       │
       ▼
[7] chat_log INSERT (role='assistant', persona, model, tokens_in, tokens_out, flags)
       │
       ▼
[8] 응답: { reply, sessionId, persona, subpersona }
```

---

## 6. 핵심 컴포넌트

### 6.1 페르소나 분류기 (`lib/persona.js`)

- **입력**: 대화 히스토리 + 현재 메시지
- **출력**: `{ persona: 'b2c'|'b2b'|'unknown', subpersona: 'b2b.switching'|null, subpersonaTags: [...] }`
- **방법**: 정규식 기반 스티키 스캔 (메시지 전체를 스캔, 과거 턴의 시그널도 유지)
- **우선순위**:
  1. B2B 서브 (`oem` > `opening` > `switching` > `office`) — 가장 강한 시그널 먼저
  2. B2B 제네릭 (명확한 B2B 시그널 있지만 서브 매칭 없음)
  3. B2C 서브 (`decaf` > `gift` > `taster` > `beginner`)
  4. B2C 제네릭 (기본값)
- **53개 테스트 케이스** (`lib/persona.test.js`) 로 우선순위 충돌·거짓양성 방지

왜 히스토리를 스캔하나? 한 턴에서 "카페 운영 중인데…" 라고 언급한 사용자가
다음 턴에 "핸드드립 레시피는요?" 라고만 물어도 여전히 B2B 로 라우팅해야 함.

### 6.2 모델 라우팅 (Haiku vs Sonnet)

| 상황 | 모델 | 이유 |
|---|---|---|
| **첫 턴** | `claude-haiku-4-5` | 첫 응답 체감 속도가 UX 전체를 결정. 프롬프트 길어도 Haiku 는 1초 내 응답. |
| 이후 B2C | `claude-haiku-4-5` | 대부분 원두 추천·레시피. Haiku 품질로 충분. |
| 이후 **B2B** | `claude-sonnet-4-20250514` | 수치·단가·계약 조건 — 추론 품질 필요. Sonnet 승격. |

환경변수로 오버라이드 가능:
- `CLAUDE_MODEL_HAIKU` (기본 `claude-haiku-4-5`)
- `CLAUDE_MODEL_SONNET` (기본 `claude-sonnet-4-20250514`, 레거시 `CLAUDE_MODEL` 도 수용)

### 6.3 카탈로그 그라운딩 (환각 방지)

**문제**: LLM은 "샘플 몇 g?" 같은 질문에 매번 다른 숫자(100g / 200g / 300g)를 지어냄.

**해결**:
1. **`data/catalog.json`** — 4개 공개 페이지를 WebFetch 로 긁어 만든 JSON.
   - 10종 원두(블렌드 4 + 싱글 4 + 디카페인 2) + 커스텀 블렌드
   - B2B MOQ 4kg, 샘플 400g 무료 최대 2종, 영업일 3일 내 발송
   - 이지드립 18g × 1/10/20개입
   - 맛 카테고리 4종 (고소·산뜻·달콤·디카페인)
2. **`lib/catalog.js`** — 페르소나별로 카탈로그를 슬라이싱해 텍스트 블록으로 포맷.
   - B2C 요청이면 B2C 주문 옵션 + 이지드립
   - B2B 요청이면 MOQ·샘플 프로그램·사이즈
3. **프롬프트에 "환각 방지 규칙" 명시**:
   ```
   - B2B 샘플은 400g 무료, 최대 2종, 영업일 3일 이내 발송 — 다른 수치 금지.
   - B2B 최소 주문(MOQ)은 4kg (400g×10 또는 1kg×4) — 다른 수치 금지.
   - 위 카탈로그에 없는 가격/수치/제품명은 절대 지어내지 마세요.
   ```

이전 → "샘플은 100g씩 제공" (매 요청마다 다름)
이후 → "400g 무료 샘플을 최대 2종까지 보내드립니다" (매번 동일, 정확)

### 6.4 페이지 안내 플로우 (`lib/links.js` + 프롬프트 규칙)

목적: AI가 대화 중 **자연스럽게** 제품 페이지로 유도하되, 링크를 들이밀지 않기.

규칙:
1. 대화가 구체화(2-3턴) 될 때까지 링크 안 던짐
2. AI 가 먼저 *"관련 페이지 바로 보여드릴까요?"* **질문**
3. 사용자가 "네/좋아요/부탁드려요" 로 **긍정** 해야 다음 턴에 URL 제시
4. 한 세션 최대 2회. 같은 링크 반복 금지
5. `lib/links.js` 에 없는 URL 은 절대 만들어내지 않음

URL 큐레이션 (서브 페르소나별):
| 서브 페르소나 | 1순위 페이지 | 2순위 페이지 |
|---|---|---|
| `b2c.beginner` | 이지드립 (드립백) | 원두 주문 |
| `b2c.decaf` | 원두 주문 (디카페인) | 이지드립 |
| `b2c.gift` | 이지드립 세트 | 원두 주문 |
| `b2c.taster` | 원두 주문 | — |
| `b2b.opening` | **샘플 신청** | 도매 주문 |
| `b2b.switching` | **샘플 신청** | 도매 주문 |
| `b2b.office` | 도매 주문 | 샘플 |
| `b2b.oem` | 샘플 (참고용) — 우선은 1:1 상담 유도 | — |

### 6.5 불만족 신호 탐지 (`lib/dissatisfaction.js`)

매 턴 사용자+AI 메시지를 분석해 `flags` JSON 을 만들어 `chat_log.flags` 에 저장.

탐지하는 신호:
- `repeat_question` — 같은 질문 2회 이상
- `emotional_spike` — 짜증·화·욕설
- `ai_confused` — AI 답변에 "잘 모르겠" / "확실하지 않" 등장
- `sales_block` — 사용자가 "그게 아니고…" / "다른 건 없나" 등
- `abandonment_risk` — 긴 침묵 후 짧은 메시지
- `topic_drift` — AI 답변이 질문과 동떨어짐

이 flags 로 나중에 대화 품질 리뷰·프롬프트 튜닝 근거 확보.

### 6.6 세션·PIPA 해시

- **세션 ID**: 브라우저 `sessionStorage.oraund_chat_session` 에 UUID 저장. 탭 닫으면 소멸. 리프레시는 유지.
- **IP 해시**: 원본 IP 저장 금지. `SHA256(ip + 오늘 날짜).slice(0, 16)` 만 저장.
  - 같은 날 같은 IP → 같은 해시 (재방문 식별 가능)
  - 다른 날 → 다른 해시 (추적 불가)
  - 한국 개인정보보호법(PIPA) 대응

---

## 7. 데이터베이스 스키마

### `chat_log` (매 턴 저장)

```sql
CREATE TABLE chat_log (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,                   -- 브라우저 sessionStorage UUID
  ts         TIMESTAMPTZ DEFAULT NOW(),
  role       TEXT CHECK (role IN ('user','assistant','system')),
  content    TEXT NOT NULL,
  persona    TEXT CHECK (persona IN ('b2c','b2b','unknown')),
  model      TEXT,                            -- e.g. claude-haiku-4-5
  tokens_in  INT,
  tokens_out INT,
  flags      JSONB DEFAULT '{}',              -- { subpersona, dissatisfaction 신호들 }
  user_agent TEXT,
  ip_hash    TEXT                             -- SHA256(ip + 날짜) 앞 16자
);

CREATE INDEX chat_log_session_ts_idx ON chat_log(session_id, ts);
CREATE INDEX chat_log_ts_idx         ON chat_log(ts DESC);
CREATE INDEX chat_log_persona_idx    ON chat_log(persona);
CREATE INDEX chat_log_flags_gin_idx  ON chat_log USING GIN (flags);
```

### `consultation_request` (상담 요청)

```sql
CREATE TABLE consultation_request (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT NOT NULL,
  ts            TIMESTAMPTZ DEFAULT NOW(),
  name          TEXT,
  phone         TEXT,
  email         TEXT,
  company       TEXT,
  notes         TEXT,
  transcript    JSONB NOT NULL,               -- 요청 시점의 대화 스냅샷
  email_sent    BOOLEAN DEFAULT false,
  email_sent_ts TIMESTAMPTZ,
  email_error   TEXT
);
```

### 자동 마이그레이션

`db.js` 의 `runMigrations()` 가 앱 시작 시 `migrations/*.sql` 을 알파벳 순으로 실행.
`_migrations` 테이블로 이미 적용된 파일 추적. 중복 실행 안전.

```sql
CREATE TABLE _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
```

새 마이그레이션은 `002_xxx.sql`, `003_xxx.sql` 로 추가만 하면 됨.

---

## 8. 이메일(상담 요청) 시스템

### 흐름

```
프론트 폼 제출
   POST /api/consult  {sessionId, name, phone, email, company, notes, transcript}
         │
         ▼
routes/consult.js
   1. consultation_request INSERT → requestId 획득
   2. plainBody + htmlBody 렌더 (대화 전체를 예쁘게 포맷)
   3. nodemailer.sendMail({ from, to: CONSULT_TO, subject, text, html })
   4. email_sent=true, email_sent_ts=now UPDATE
         │
         ▼
영업팀 메일함 (info@oraund.com + bywockd@gmail.com)
```

### 환경변수

```bash
SMTP_HOST=smtp.gmail.com           # Naver: smtp.naver.com
SMTP_PORT=587                      # 또는 465 (SSL)
SMTP_USER=<발송자 계정>
SMTP_PASS=<앱 비밀번호>
SMTP_FROM=oraund@gmail.com         # 생략 시 SMTP_USER 사용
CONSULT_TO=info@oraund.com,bywockd@gmail.com
```

### Gmail 앱 비밀번호 (권장)

1. Google 계정 → 보안 → 2단계 인증 켜기
2. "앱 비밀번호" 생성 → 16자 문자열 획득
3. `SMTP_PASS` 에 그 비밀번호 넣기 (본인 Gmail 비번 아님)

### SMTP 미설정 시 동작 (Dry-run)

환경변수가 하나라도 비어 있으면 **이메일 비활성 모드**로 부팅:
```
[consult] SMTP_* env vars missing — email sending is DISABLED (logs only)
```
상담 요청 자체는 DB 에 저장되고, 로그로 출력. `email_sent=false, email_error='SMTP_NOT_CONFIGURED'` 로 마킹.

### 이메일 본문 포맷

```
[ORAUND 상담 요청] 서울커피랩 — session b3c2fe73
────────────────────────────────────────
요청시간 : 2026-04-22 23:12:45
세션ID   : b3c2fe73-...-8a5ea98717d2
회사명   : 서울커피랩
성함     : 김민수
연락처   : 010-0000-0000
이메일   : demo-cafe@example.com
메모     : 디카페인 샘플 200g 1-2종, 월 8kg 정기 납품 단가 안내 부탁드립니다.

--- 대화 내용 ---
[1] 👤 고객
카페 운영 중인데 지금 쓰는 디카페인이 바디가 약해서 바꾸려고요. 월 8kg 정도 씁니다

[2] 🤖 AI
콜롬비아 디카페인(39,000원/1kg)을 추천드립니다. ...
```

HTML 버전도 함께 발송. `Reply-To` 는 사용자 이메일로 자동 세팅 → 영업팀이 답장하면 고객에게 바로 감.

---

## 9. 프론트엔드 위젯

`public/oraund-chat.js` — 단일 파일 드롭인 스크립트. 빌드 없음.

### 호스트 페이지에 필요한 DOM

Cafe24 스킨의 모든 페이지가 **공통으로** 아래 엘리먼트를 가지고 있어야 함:

```html
<div id="aiPanel" hidden>
  <div id="chatMessages"></div>
  <div id="aiWelcome">...</div>          <!-- 첫 메시지 시 숨김 -->
  <input id="chatInput" />
  <button id="sendBtn">전송</button>
</div>

<!-- 위젯 로더 (이 줄만 있으면 됨) -->
<script defer
  src="https://oraund-backend-production.up.railway.app/oraund-chat.js">
</script>
```

### 위젯이 하는 일

- `sessionStorage.oraund_chat_session` 에서 UUID 읽기/생성
- `POST /api/chat` 으로 대화 전송, 응답 렌더링 (마크다운 링크 → `<a target="_blank">`)
- 첫 AI 응답 후 하단에 **"위 대화 내용으로 상담 요청하기 →"** CTA 바 삽입
- CTA 클릭 시 상담 모달 표시 (성함·회사/매장명·연락처·이메일·추가요청사항)
- 모달 제출 시 `POST /api/consult` 로 대화 전체 + 리드 정보 전송
- ESC / 바깥 클릭 / 취소 버튼으로 닫기
- **Idempotent** — 스크립트 두 번 로드되어도 안전 (`window.__oraundChatLoaded` 가드)

### CORS

백엔드의 `server.js` 가 `origin: '*'` 로 열려 있어 `oraund.com` 어떤 경로에서든 로드 가능. 운영 단계에서 보안 강화 원하면 `origin: ['https://oraund.com', 'https://jcpinter.cafe24.com']` 로 제한.

---

## 10. Railway 배포

### 최초 세팅

1. **GitHub 리포지토리** 로 코드 푸시
2. Railway → "New Project" → "Deploy from GitHub repo" → 해당 리포 선택
3. Railway 가 자동 감지:
   - `package.json` 의 `"start": "node server.js"` 를 엔트리로 인식
   - `engines.node` 버전에 맞춰 빌드
4. **Postgres 플러그인 추가** (같은 프로젝트 안에서 "+ New" → "Database" → "PostgreSQL")
   - `DATABASE_URL` 이 자동으로 Node 서비스에 주입됨
5. **환경변수 설정** (서비스 → Variables 탭):
   - `ANTHROPIC_API_KEY` — 필수
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `CONSULT_TO` — 상담 메일 받으려면 필수
6. **Public 도메인 할당** (Settings → Networking → "Generate Domain")
   - `https://<project>-production.up.railway.app` 형태
7. **Cafe24 스킨의 `<script src>`** 를 그 도메인으로 갱신

### 자동 배포

- `main` 브랜치에 `git push` → Railway 가 감지 → 빌드 → 배포
- 평균 배포 시간 **60-120초**
- 배포 실패 시 이전 버전 자동 유지 (zero-downtime)
- 로그는 Railway UI 의 "Deployments" 탭에서 실시간 확인

### 헬스 체크

Railway 는 `/health` 가 200 응답하면 정상으로 간주:
```json
{ "status": "OK", "message": "...", "db": "ok", "ts": "..." }
```

### 롤백

Railway Deployments 탭 → 원하는 과거 배포 선택 → "Redeploy"

---

## 11. 환경변수 레퍼런스

| 이름 | 필수 | 기본값 | 비고 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic 콘솔에서 발급 |
| `CLAUDE_MODEL_HAIKU` | ❌ | `claude-haiku-4-5` | B2C · 첫 턴용 |
| `CLAUDE_MODEL_SONNET` | ❌ | `claude-sonnet-4-20250514` | B2B 서브 모델 |
| `CLAUDE_MODEL` | ❌ | — | 레거시 폴백 (Sonnet 용으로 해석) |
| `DATABASE_URL` | ❌ | — | Railway Postgres 가 자동 주입. 없으면 로깅 비활성. |
| `PORT` | ❌ | `3000` | Railway 는 자기 포트 자동 주입 |
| `SMTP_HOST` | ❌* | — | *이메일 발송 필요 시 필수 |
| `SMTP_PORT` | ❌* | — | 587 (STARTTLS) 또는 465 (SSL) |
| `SMTP_USER` | ❌* | — | 발송 계정 |
| `SMTP_PASS` | ❌* | — | 앱 비밀번호 (일반 비번 X) |
| `SMTP_FROM` | ❌ | `SMTP_USER` | From 주소 |
| `CONSULT_TO` | ❌ | `info@oraund.com,bywockd@gmail.com` | 콤마 구분 다중 수신 |

SMTP 4종(HOST/PORT/USER/PASS) 중 **하나라도** 비면 dry-run 모드로 부팅. 부분 설정 안 됨.

---

## 12. 로컬 개발

```bash
git clone https://github.com/<user>/oraund-backend.git
cd oraund-backend
npm install

cat > .env <<EOF
ANTHROPIC_API_KEY=sk-ant-...
# DATABASE_URL=postgresql://...   ← 선택, 없으면 로깅 비활성
# SMTP_HOST=smtp.gmail.com        ← 선택, 없으면 dry-run
# SMTP_PORT=587
# SMTP_USER=...
# SMTP_PASS=...
EOF

npm run dev           # nodemon 으로 자동 재시작
```

http://localhost:3000/health 로 헬스 확인.

### 테스트

```bash
node lib/persona.test.js
# 53 passed, 0 failed (53 total)
```

### 프롬프트 미리보기

```bash
node -e "
const p = require('./prompts');
console.log(p.buildSystemPrompt('b2b', 'b2b.switching'));
" | less
```

### 수동 API 테스트

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message":"샘플 몇 g 받을 수 있어요?",
    "history":[
      {"role":"user","content":"카페 오픈 준비 중이에요"},
      {"role":"assistant","content":"네, 어떤 도움이 필요하세요?"}
    ]
  }'
```

---

## 13. 다른 브랜드로 복제하는 법 — 체크리스트

오라운트가 아닌 새 브랜드(가령 "소월 베이커리") 로 동일한 챗봇을 만들려면:

### A. 페이지 데이터 수집 (가장 중요)
- [ ] 브랜드의 **핵심 페이지 URL 4-5개** 선정 (제품 리스트, 도매/B2B, 샘플·문의 등)
- [ ] 각 페이지 WebFetch 로 긁기 → 하드 팩트 추출 (MOQ·가격·사이즈·재료 등)
- [ ] `data/catalog.json` 새로 작성 — 오라운트 템플릿 참고
- [ ] 특히 주의: AI가 지어낼 가능성 높은 수치(무게·수량·리드타임) 확실히 박기

### B. 페르소나 재정의
- [ ] `lib/persona.js` 의 정규식 패턴 수정
  - B2B 시그널 ("카페 운영", "월 납품" 등) → 브랜드 업종에 맞게 재작성
  - 서브 페르소나 4+4 구조는 유지하되 의미 재정의 (예: 베이커리라면 b2c.celebration, b2b.hotel, b2b.subscription 등)
- [ ] `lib/persona.test.js` 의 53 케이스도 새 브랜드 맥락으로 재작성

### C. 프롬프트 재작성
- [ ] `prompts/index.js` 의 B2C_PROMPT / B2B_PROMPT 역할 문구 수정 ("바리스타" → "제빵사" 등)
- [ ] 예시 대화 (예시 1, 2, 3…) 를 실제 브랜드 예시로 교체
- [ ] 톤: 감성/비즈니스 레지스터 차이 유지 (B2C 는 따뜻하게, B2B 는 정중하게)
- [ ] 환각 방지 규칙의 수치는 catalog.json 과 일치

### D. 링크 큐레이션
- [ ] `lib/links.js` 의 서브 페르소나별 URL 매핑 재작성
- [ ] 첫 안내 페이지 vs 후속 안내 페이지 우선순위 설정

### E. 프론트 위젯 적용
- [ ] `public/oraund-chat.js` 에서 `'oraund'` 관련 리터럴 검색·교체
  - sessionStorage 키 이름
  - 기본 CTA 문구 ("위 대화 내용으로 상담 요청하기")
  - 모달 제목·안내문
- [ ] 색상·폰트 등 CSS 인라인 → 브랜드 톤에 맞춰 수정

### F. 이메일 문구
- [ ] `routes/consult.js` 의 `subject` 템플릿 (`[ORAUND 상담 요청]` → 새 브랜드명)
- [ ] HTML 본문 색상(`#6b4e3a` 커피 브라운) → 브랜드 컬러로 교체

### G. 배포
- [ ] 새 GitHub 리포 생성, 코드 푸시
- [ ] Railway 프로젝트 새로 만들기 (Postgres 플러그인 포함)
- [ ] ENV 세팅 (ANTHROPIC_API_KEY + SMTP + CONSULT_TO)
- [ ] Cafe24(또는 다른 CMS) 스킨에 `<script>` 삽입

### H. 검증
- [ ] `/health` 200 확인
- [ ] 첫 턴 → Haiku + B2C 응답 확인
- [ ] B2B 시나리오 2-3턴 → Sonnet 승격 확인 (응답 헤더의 `persona` 필드)
- [ ] 샘플·MOQ 같은 핵심 수치 질문 → catalog.json 값 그대로 나오는지
- [ ] "관련 페이지 보여드릴까요?" → "네" → URL 제시 플로우 확인
- [ ] 상담 요청 폼 제출 → 영업팀 메일 실제 수신 확인

---

## 14. 자주 마주치는 이슈

### AI가 존재하지 않는 제품/가격을 답한다
- `data/catalog.json` 에 해당 항목이 누락됐거나 표현이 모호함
- `prompts/index.js` 의 환각 방지 규칙에 해당 수치를 명시적으로 박아넣기:
  ```
  - B2B 샘플은 400g 무료, 최대 2종 — 다른 수치 금지.
  ```
- `node -e "console.log(require('./prompts').buildSystemPrompt('b2b', null))"` 로 실제 프롬프트 직접 확인

### 링크가 매 턴마다 쏟아진다
- `prompts/index.js` 의 PAGE_GUIDANCE_RULE 강화:
  - "한 세션 최대 2회" 를 "최대 1회" 로 조이기
  - "**첫 턴에서 링크 던지기 금지**" 명시적 반복
- 예시 대화에서도 "먼저 질문 → 긍정 → 링크" 순서 강조

### 페르소나 오분류 (B2B 인데 B2C 로 라우팅)
- `lib/persona.test.js` 에 실제 오분류 케이스 추가하고 실패시킨 뒤 정규식 수정
- 히스토리 스캔 로직(`classifyFromHistory`)이 과거 B2B 시그널을 잃어버리지 않는지 확인

### 상담 요청이 영업팀 메일에 안 온다
- Railway 로그에서 `[consult] SMTP_* env vars missing` 나오면 → ENV 미설정
- `[consult] sendMail failed: ...` 나오면 → SMTP 인증/호스트 문제
- Gmail: 2단계 인증 + 앱 비밀번호 썼는지 확인 (일반 비번은 차단됨)
- DB 에는 `email_sent=false, email_error='...'` 로 기록되므로 `SELECT email_error FROM consultation_request ORDER BY ts DESC LIMIT 5` 로 최근 원인 확인

### Railway 배포가 오래 걸림 (> 3분)
- `npm install` 이 무거우면 `.dockerignore` / `.railwayignore` 점검
- `node_modules` 가 커밋되어 있지 않은지 (`git ls-files node_modules` 가 비어야 함)
- Railway 의 Nixpacks 빌더가 캐시 못 쓰면 느려짐 → `engines.node` 고정

### 첫 턴이 느림 (> 3초)
- Haiku 인데도 느리면 `max_tokens` 낮추기 (현재 500 — 300으로 낮춰 테스트)
- 프롬프트 길이 확인 (현재 B2C 첫 턴 프롬프트 약 4500자). 너무 길면 카탈로그 슬라이스 재조정.

### 브라우저에서 위젯이 안 뜸
- 콘솔에서 `window.__oraundChatLoaded` 값 확인
  - `undefined` → 스크립트 자체가 로드 안 됨 (404/CORS)
  - `true` 인데 안 뜸 → 호스트 페이지의 `#aiPanel` DOM 이 없거나 ID 다름
- 네트워크 탭에서 `oraund-chat.js` 응답 상태 확인
- Cafe24 에서 `<script>` 가 `</body>` 앞에 있는지

---

## 부록: 이 프로젝트의 커밋 히스토리 (아키텍처 진화 궤적)

```
ddb380b  Ground prompts in real page data (catalog.json) + add page-guidance rule
0726a96  Widen B2C/B2B prompt scope so AI stops refusing brewing + recipe questions
524e9fe  Split persona detection into 8 sub-personas with prompt hint injection
3215763  Split B2C/B2B personas with turn-aware model routing
1f459fa  Rewrite header subtitle to 'Powered by Anthropic Claude' at runtime
2d46dec  Rewire malformed welcome-chip onclicks from the Cafe24-rendered HTML
```

각 커밋이 하나의 "설계 결정" 을 담고 있음. 복제 시 이 순서대로 구현하면 중간
단계마다 실제로 돌아가는 챗봇을 볼 수 있어 디버깅 쉬움.

1. **`3215763`**: 단일 프롬프트 → B2C/B2B 분리, 턴 기반 모델 라우팅
2. **`524e9fe`**: 2-way → 8-way 서브 페르소나 + 힌트 주입
3. **`0726a96`**: AI가 "영업 담당이라 그건…" 회피 → 프롬프트 범위 명시적 확대
4. **`ddb380b`**: 환각 → 카탈로그 기반 팩트 그라운딩 + 페이지 안내 규칙

---

**마지막 업데이트**: 2026-04-22
**작성**: Claude + JCP
