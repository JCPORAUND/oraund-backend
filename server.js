// server.js - Google Gemini API 백엔드 서버

const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 - CORS 설정 추가
app.use(cors({
  origin: '*', // 모든 도메인 허용
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());

// Google Gemini AI 초기화
// 환경 변수로 API 키를 설정하세요
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// 오라운트 커피 정보 데이터베이스
const COFFEE_DATABASE = `
오라운트 커피는 경기광주에 위치한 세계 최대 로스터리 카페입니다.
구글, 위워크 같은 글로벌 기업에 원두를 납품하고 있습니다.

=== 판매 중인 원두 ===

1. 운트 블렌드 (고소한맛) - 29,000원/1kg
   - 원산지: 콜롬비아 40%, 케냐 20%, 과테말라 40%
   - 로스팅: 미디엄 다크
   - 맛: 진하고 고소한 바디감, 다크 초콜릿과 견과류 풍미
   - 산미: 낮음
   - 바디: 진함
   - 추천: 라떼, 카푸치노, 에스프레소에 최적
   - 특징: 구글 오피스 납품 원두, 베스트셀러

2. 알소 블렌드 (산뜻한맛) - 37,500원/1kg
   - 원산지: 에티오피아 싱글 오리진
   - 로스팅: 라이트 미디엄
   - 맛: 플로랄 향미의 아로마, 시트러스와 베리 향
   - 산미: 높음
   - 바디: 가벼움
   - 추천: 핸드드립, 푸어오버에 최적
   - 특징: 꽃향기와 과일향이 풍부, 산미 애호가용

3. 이웃 블렌드 (달콤한맛) - 28,500원/1kg
   - 원산지: 브라질 블렌드
   - 로스팅: 미디엄
   - 맛: 부드럽고 달콤한 맛, 캐러멜과 초콜릿 풍미
   - 산미: 중간
   - 바디: 중간
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

// 시스템 프롬프트
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

// 채팅 엔드포인트
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message) {
      return res.status(400).json({ error: '메시지가 필요합니다.' });
    }

    // Gemini Pro 모델 사용
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

    // 대화 히스토리 구성
    const chatHistory = history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    // 채팅 시작
    const chat = model.startChat({
      history: chatHistory,
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    });

    // 시스템 프롬프트와 사용자 메시지 결합
    const fullMessage = chatHistory.length === 0 
      ? `${SYSTEM_PROMPT}\n\n사용자: ${message}`
      : message;

    const result = await chat.sendMessage(fullMessage);
    const response = await result.response;
    const reply = response.text();

    res.json({ reply });

  } catch (error) {
    console.error('Gemini API 오류:', error);
    res.status(500).json({ 
      error: '죄송합니다. 일시적인 오류가 발생했습니다.',
      details: error.message 
    });
  }
});

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Oraund Chatbot Server is running' });
});

// 루트 엔드포인트
app.get('/', (req, res) => {
  res.json({ 
    message: 'Oraund Chatbot API',
    endpoints: {
      chat: 'POST /api/chat',
      health: 'GET /health'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 실행중입니다`);
  console.log(`💚 AMG F1 Petronas 컬러로 오라운트 챗봇 준비 완료!`);
});

module.exports = app;
