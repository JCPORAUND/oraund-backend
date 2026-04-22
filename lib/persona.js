// lib/persona.js — B2C / B2B 페르소나 분기
//
// ⚠️ 현재 상태: 모든 세션을 'unknown' 으로 반환.
//    실제 페르소나 설계 & 키워드 튜닝은 실제 대화 데이터를 보고 나서
//    사용자와 함께 진행 예정. 이 모듈은 그 자리를 미리 잡아둔 것.
//
// 추후 구현 방향 (인터페이스 고정용 주석):
//   - 세션의 첫 user 메시지에서 B2B 키워드 감지 시 'b2b' 반환
//   - 한 번 'b2b' 로 분류되면 세션 종료까지 유지 (sticky)
//   - session-level cache 는 routes/chat.js 에서 관리

function classify(_firstUserMessage) {
  // TODO: 데이터 수집 후 키워드 튜닝하여 실제 분류 구현
  return 'unknown';
}

module.exports = { classify };
