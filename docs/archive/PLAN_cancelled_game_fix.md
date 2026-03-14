# 계획: Cancelled 게임 Stuck 문제 수정

## 문서 정보
- 작성일: 2026-03-14
- 상태: 검증 대기
- 대상 버전: v1.0.12

## 문제 정의

GC 서버 재배포 시 진행 중인 게임이 `cancelled` 상태로 전환되지만,
에이전트가 이를 감지하지 못하고 영구적으로 해당 게임에 stuck됨.

### 현상
1. WebSocket 재접속 시 `_onReconnect()`에서 `cancelled` 상태를 처리하지 않음
2. `discoverGames()`에서 `activeGameId` 존재 시 무조건 `busy` 반환 (유효성 검증 없음)
3. 게임 #83이 cancelled 상태에서 re-join 반복, 새 게임 탐색 영구 차단

### 근본 원인
`_onReconnect()` 조건문: `state === 'ended' || state === 'archived'` 에서 `cancelled` 누락

## 수정 계획

### 변경 1: _onReconnect()에 cancelled 상태 추가
- **파일**: `/home/ec2-user/.cokacdir/shared/appback-ai-agent/src/adapters/gc/GcAdapter.js`
- **위치**: `_onReconnect()` 메서드 내 state 체크 조건
- **변경**: `ended`/`archived` 외에 `cancelled` 포함
- **동작**: cancelled 감지 시 `onGameEnd()` 호출하여 정리 (result는 null — 결과 없음)

### 변경 2: discoverGames()에 activeGame 유효성 검증 추가
- **파일**: 동일 GcAdapter.js
- **위치**: `discoverGames()` 메서드 시작 부분
- **변경**: `activeGameId` 존재 시 API로 게임 상태 조회 → 비활성 상태면 정리 후 탐색 진행
- **비활성 상태**: `ended`, `archived`, `cancelled`
- **주의**: API 호출 실패(404 등)도 정리 대상

### 변경 3 (선택): game_cancelled 소켓 이벤트 리스너
- **파일**: `/home/ec2-user/.cokacdir/shared/appback-ai-agent/src/adapters/gc/GcSocketClient.js`
- **판단**: GC 서버가 `game_cancelled` 이벤트를 broadcast하는지 먼저 확인 필요
- **보류 사유**: GC 소켓 이벤트 목록 미확인. 변경 1+2로 충분히 해결 가능

## 비활성 상태 정의
```javascript
const INACTIVE_STATES = ['ended', 'archived', 'cancelled']
```
- 향후 다른 비활성 상태가 추가되어도 배열 한 곳만 수정하면 됨

## 테스트 계획
1. pm2 restart 후 cancelled 상태의 게임 #83에서 정상 탈출하는지 확인
2. 로그에서 `no longer playable (cancelled), cleaning up` 메시지 확인
3. 이후 새 게임 탐색이 재개되는지 확인
4. 정상 게임 진행 중 재접속 시 기존 동작(re-join) 유지 확인

## 배포 계획
1. 코드 수정
2. `npm version patch` → v1.0.12
3. `npm publish`
4. `pm2 restart appback-ai-agent`
5. 로그 모니터링으로 정상 동작 확인
