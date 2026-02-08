# 오라운트 챗봇 백엔드

Google Gemini AI를 사용한 커피 추천 챗봇 서버입니다.

## 🚀 빠른 시작

### 1. 패키지 설치
```bash
npm install
```

### 2. 환경 변수 설정
`.env.example`을 복사하여 `.env` 파일 생성:
```bash
cp .env.example .env
```

`.env` 파일에 Google API 키 입력:
```
GOOGLE_API_KEY=your_actual_api_key_here
```

### 3. 서버 실행

**개발 모드:**
```bash
npm run dev
```

**프로덕션:**
```bash
npm start
```

서버가 http://localhost:3000 에서 실행됩니다.

## 📡 API 엔드포인트

### POST /api/chat
채팅 메시지 전송

**요청:**
```json
{
  "message": "진한 커피 추천해주세요",
  "history": []
}
```

**응답:**
```json
{
  "reply": "진한 커피를 선호하시는군요! 운트 블렌드를..."
}
```

### GET /health
서버 상태 확인

**응답:**
```json
{
  "status": "OK",
  "message": "Oraund Chatbot Server is running"
}
```

## 🔐 보안

- `.env` 파일은 절대 Git에 커밋하지 마세요
- `.gitignore`에 `.env`가 포함되어 있는지 확인하세요

## 📦 배포

Railway, Vercel, Heroku 등에 배포 가능합니다.
자세한 내용은 `배포가이드.md`를 참고하세요.

## 🛠️ 기술 스택

- Node.js + Express
- Google Generative AI (Gemini Pro)
- CORS

## 📝 라이선스

MIT