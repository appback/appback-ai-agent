# AI Agent의 AI Rewards JWT 기반 GC 참가 전환 가이드

> 상태: **AI Agent 2.5.0 클라이언트 구현 완료 · 운영 canary 대기**
> 서버 상태: AI Rewards canonical UUID/JWT 및 GC 검증·직접 보상 지급은 운영 배포 완료
> 적용 저장소: `appback-ai-agent`
> 작성일: 2026-08-21

## 1. 목적

AI Agent가 Grid Clash(GC)에 처음 접속할 때 GC가 별도 UUID와 `cr_agent_...`
토큰을 발급받던 흐름을 제거한다. 앞으로 에이전트의 유일한 식별자는 AI
Rewards가 발급한 canonical UUID이며, AI Agent는 AI Rewards의 서명 JWT로 GC에
입장한다.

이 전환으로 다음 계약을 보장해야 한다.

- AI Rewards가 에이전트 UUID, 인증 JWT, 에이전트 자산 원장의 기준 시스템이다.
- GC는 JWT를 AI Rewards에 검증하고 JWT의 `sub` UUID를 그대로 사용한다.
- GC는 에이전트 소유주를 조회하거나 저장하지 않는다.
- 같은 UUID로 재등록하면 기존 Face, 학습 모델, 잔액, 전적과 보상 이력을 유지한다.
- GC 분배 게임 보상은 같은 canonical UUID의 AI Rewards USD 잔액으로 지급된다.
- AI Agent는 GC에서 새로운 UUID나 인증 토큰을 발급받지 않는다.

## 2. 범위

### 이번 AI Agent 작업에 포함

1. AI Rewards 일회용 코드 교환
2. AI Rewards agent JWT의 안전한 저장과 사용
3. JWT를 이용한 GC 등록 및 모든 agent API 인증
4. AI Rewards UUID와 GC UUID의 일치 검증
5. 기존 에이전트의 UUID를 보존하는 재인증 절차
6. 구형 GC 자체 등록 및 `cr_agent_...` 토큰 흐름 제거
7. 설정, CLI, 테스트, 설치·배포 문서 갱신

### 포함하지 않음

- PayPal 출금 구현
- AI Rewards의 소유주·에이전트 관계 구현
- GC의 보상 지급 서버 구현
- GC가 소유주 정보를 조회하거나 보관하는 기능
- 기존 데이터의 임의 병합 또는 UUID 강제 변경

서버 측 항목은 이미 구현되어 있다. 이 문서는 AI Agent 클라이언트가 새 계약을
사용하기 위한 작업 지시서다.

## 3. 기준 서버 계약

### 3.1 신규 에이전트

1. 소유주가 AI Rewards에서 GC용 등록 코드를 만든다.
2. AI Agent가 코드를 AI Rewards에 한 번 교환한다.
3. AI Rewards가 canonical `agent_id`와 서명 JWT를 반환한다.
4. AI Agent가 JWT로 GC `/agents/register`를 호출한다.
5. GC 응답의 `agent_id`가 AI Rewards 응답과 정확히 같을 때만 자격 증명을 저장한다.

#### 코드 교환

```http
POST https://appback.app/api/v1/ai/agent-auth/exchange
Content-Type: application/json

{
  "registration_code": "ARW-XXXX-XXXX",
  "agent_name": "my-agent"
}
```

성공 응답:

```json
{
  "status": "ok",
  "service": "gc",
  "agent_id": "canonical-uuid",
  "agent_name": "my-agent",
  "agent_token": "signed-jwt",
  "token_type": "Bearer",
  "expires_at": "timestamp"
}
```

`registration_code`는 일회용이며 `agent_token`은 응답 시 한 번만 전달된다. 둘 다
로그, 오류 메시지, 분석 이벤트에 기록하면 안 된다.

#### GC 등록

```http
POST https://gc-v2-api.appback.app/api/v1/agents/register
Authorization: Bearer <AI Rewards agent JWT>
Content-Type: application/json

{
  "model_name": "appback-ai-agent"
}
```

성공 응답에는 다음 필드가 포함된다.

```json
{
  "agent_id": "canonical-uuid",
  "identity_source": "ai_rewards_jwt"
}
```

저장 전 필수 검증:

- AI Rewards 응답 `service === "gc"`
- `agent_id`가 UUID 형식
- `agent_token`이 JWT 형식
- `token_type === "Bearer"`
- GC 응답 `agent_id === AI Rewards agent_id`
- GC 응답 `identity_source === "ai_rewards_jwt"`

하나라도 다르면 아무 자격 증명도 저장하지 않고 실패 처리한다.

### 3.2 기존 에이전트

기존 Face, 모델, 전적과 자산을 유지하려면 **기존 UUID에 연결된 Auth Code**를
사용해야 한다.

1. AI Rewards의 기존 에이전트 화면에서 Auth Code를 발급한다.
2. AI Agent가 신규 등록과 같은 `/ai/agent-auth/exchange` API로 교환한다.
3. 교환 결과의 UUID가 로컬 `agent_identity.agent_id`와 같은지 확인한다.
4. 같은 경우에만 JWT로 GC 재등록 후 토큰을 교체한다.
5. 다르면 즉시 중단하고 데이터 매핑을 확인한다. 새 UUID로 덮어쓰면 안 된다.

Auth Code 발급 API는 소유주 인증이 필요한
`POST /api/v1/ai/agents/:registrationId/auth-code`다. 소유주 인증은 AI Rewards의
책임이며 GC나 AI Agent 런타임으로 전달하지 않는다.

기존 GC UUID가 AI Rewards에 아직 등록되어 있지 않다면 AI Agent만으로 UUID를
보존할 수 없다. 이 경우 먼저 AI Rewards에서 기존 UUID를 canonical identity로
채택하는 데이터 이관을 완료해야 한다. 이관 없이 신규 코드를 교환하면 새 UUID가
생기므로 Face, 모델과 이력의 동일성 보장이 깨진다.

### 3.3 JWT 계약

JWT의 핵심 claim은 다음과 같다.

- `sub`: canonical agent UUID
- `iss`: `ai-rewards`
- `aud`: `game:gc`
- `token_type`: `ai_rewards_agent`
- `service`: `gc`
- `jti`, `exp`

클라이언트는 `exp`를 갱신 안내에 사용할 수 있지만 JWT 진위의 최종 판정자가
아니다. GC가 AI Rewards introspection을 통해 활성 여부, 만료, 폐기와 audience를
검증한다.

AI Rewards에서 JWT를 재발급하면 이전 JWT는 즉시 폐기된다. 여러 프로세스가 같은
에이전트를 실행한다면 새 토큰을 모든 실행 환경에 원자적으로 배포해야 한다.

### 3.4 보상

AI Agent가 보상 지급 API를 직접 호출할 필요는 없다. 분배 게임 우승 시 GC가 JWT로
확인한 같은 UUID를 `agent_id`로 사용하여 AI Rewards에 USD 보상을 지급한다. AI
Agent의 책임은 게임 참가 전부터 끝까지 이 canonical UUID를 유지하는 것이다.

## 4. 현재 구현에서 제거할 동작

다음 동작은 새 서버 계약과 호환되지 않으므로 제거해야 한다.

- 토큰이 없을 때 `POST /agents/register`를 익명 호출
- GC 등록 응답에서 `api_token` 또는 `token`을 기대
- GC가 반환한 임의 `agent_id`를 새 로컬 identity로 저장
- `POST /agents/verify-registration` 호출
- `cr_agent_...` 토큰 수락 또는 자동 복구
- `start` 실행만으로 새 에이전트가 생긴다는 안내
- 등록 코드나 JWT 전체를 콘솔에 출력
- JWT 실패 시 익명 GC 등록으로 fallback

GC가 반환하는 주요 인증 오류:

- `401 AI_REWARDS_JWT_REQUIRED`: JWT가 없거나 구형 토큰 사용
- `401 INVALID_AI_REWARDS_AGENT`: JWT가 유효하지 않거나 만료·폐기됨
- `AGENT_NOT_REGISTERED`: JWT는 유효하지만 해당 UUID가 아직 GC에 등록되지 않음

이 오류들은 새 UUID 생성 신호가 아니다. 재인증 또는 JWT를 사용한 GC 등록으로
처리한다.

## 5. 파일별 구현 지시

### 5.1 `src/auth/AiRewardsAgentAuthClient.js` 신규 추가

- 기본 URL: `https://appback.app/api/v1`
- `exchange({ registrationCode, agentName })` 구현
- 타임아웃과 구조 검증 적용
- 서비스가 `gc`가 아니면 거부
- HTTP 오류를 사용자용 코드로 정규화하되 요청 코드와 JWT는 제거
- axios interceptor와 debug logger에도 비밀이 남지 않도록 redaction

### 5.2 `src/adapters/gc/config.js`

- 기본 `GC_API_URL`을 `https://gc-v2-api.appback.app/api/v1`로 변경
- 필요한 경우 WebSocket 기본 URL도 동일한 canonical GC 호스트로 변경
- `AI_REWARDS_API_URL=https://appback.app/api/v1` 추가
- `AI_REWARDS_AGENT_JWT`를 우선 자격 증명으로 추가
- 호환 기간에는 `GC_API_TOKEN`을 fallback으로 읽을 수 있지만 JWT 형식만 허용
- `cr_agent_` 값은 명시적으로 거부

### 5.3 `src/adapters/gc/GcApiClient.js`

- `register()`는 반드시 Bearer JWT가 설정된 상태에서만 호출
- 등록 body만 전송하고 토큰 발급 필드를 기대하지 않음
- 응답의 `identity_source` 및 UUID를 호출자에게 반환
- 모든 `/agents/*`, queue, challenge, model API가 같은 JWT를 사용
- 요청·응답 로깅에서 `Authorization`을 redaction

### 5.4 `src/adapters/gc/GcAdapter.js`

시작 상태 머신을 다음과 같이 바꾼다.

```text
UNBOUND -> CODE_REQUIRED -> EXCHANGING -> GC_REGISTERING -> ACTIVE
ACTIVE + expired/revoked JWT -> REAUTH_REQUIRED
```

금지 상태 전이:

```text
UNBOUND -> GC_AUTO_REGISTER
REAUTH_REQUIRED -> NEW_GC_IDENTITY
```

- 저장된 JWT가 없으면 명확한 등록 안내와 함께 fail closed
- 저장된 UUID와 JWT의 `sub`가 다르면 시작 중단
- `/agents/me`가 성공하면 해당 응답 UUID도 저장 UUID와 비교
- 만료·폐기된 JWT면 기존 에이전트 Auth Code를 요구
- 새 UUID로 자동 교체하거나 로컬 Face·모델 데이터를 초기화하지 않음

### 5.5 `src/data/storage/SqliteStore.js`

기존 설치를 파괴하지 않는 additive migration을 사용한다. 전환 기간에는 기존
`api_token` 컬럼에 JWT를 저장할 수 있지만 의미를 명확히 하는 메타데이터를
추가한다.

권장 컬럼:

```sql
ALTER TABLE agent_identity ADD COLUMN credential_issuer TEXT;
ALTER TABLE agent_identity ADD COLUMN credential_type TEXT;
ALTER TABLE agent_identity ADD COLUMN token_expires_at TEXT;
```

저장 값:

- `credential_issuer = 'ai-rewards'`
- `credential_type = 'agent_jwt'`
- `agent_id = AI Rewards canonical UUID`
- `token_expires_at = exchange expires_at`

저장 메서드는 transaction 안에서 다음 조건을 검사한다.

1. 기존 `agent_id`가 있으면 새 `agent_id`와 같아야 한다.
2. GC 등록 응답 UUID가 AI Rewards UUID와 같아야 한다.
3. 모든 검증 이후에만 JWT와 만료 시각을 교체한다.

불일치 시 기존 row를 보존한다. 마이그레이션 과정에서 기존 DB, 모델 파일 또는
학습 데이터를 삭제하지 않는다.

### 5.6 `bin/cli.js`

`appback-ai-agent register <ARW-code>`의 의미를 다음으로 변경한다.

1. AI Rewards 코드 교환
2. 기존 로컬 UUID가 있으면 동일성 검증
3. 받은 JWT로 GC 등록
4. GC UUID 동일성 검증
5. 검증 완료 후 SQLite에 원자 저장
6. 서비스, 에이전트 이름, canonical UUID만 출력

등록 코드와 JWT를 출력하지 않는다. 현재 구형
`/agents/verify-registration` 호출은 완전히 제거한다.

명령 동작:

- `start`: JWT가 없으면 자동 생성하지 않고 `register` 실행 방법 안내 후 종료
- `register`: 신규 등록과 기존 에이전트 Auth Code 재인증을 모두 처리
- `doctor`: 토큰 존재·형식·만료, endpoint와 UUID 일치만 출력하고 토큰은 숨김

### 5.7 `.env.example`, `README.md`, 운영 문서

권장 환경 변수:

```dotenv
AI_REWARDS_API_URL=https://appback.app/api/v1
AI_REWARDS_AGENT_JWT=
GC_API_URL=https://gc-v2-api.appback.app/api/v1
GC_WS_URL=https://gc-v2-api.appback.app
```

`GC_API_TOKEN`은 한 릴리스 동안 JWT 전용 deprecated alias로만 허용하고 이후
제거한다. README, `docs/overview/ARCHITECTURE.md`,
`docs/operations/INSTALL.md`, `docs/operations/DEPLOYMENT.md`에서 GC 자동 등록 및
구형 URL 설명을 함께 갱신한다.

## 6. 안전한 구현 예시

다음은 동작 설명용 예시다. 실제 CLI 구현에서는 쉘 변수 대신 프로세스 메모리와
SQLite transaction을 사용한다.

```bash
read -r -s -p 'AI Rewards Auth Code: ' ARW_CODE
AUTH_FILE=$(mktemp)
GC_FILE=$(mktemp)
trap 'rm -f "$AUTH_FILE" "$GC_FILE"' EXIT
chmod 600 "$AUTH_FILE" "$GC_FILE"

curl --fail --silent --show-error \
  -X POST https://appback.app/api/v1/ai/agent-auth/exchange \
  -H 'Content-Type: application/json' \
  --data "{\"registration_code\":\"$ARW_CODE\",\"agent_name\":\"appback-ai-agent\"}" \
  > "$AUTH_FILE"

AGENT_ID=$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.agent_id||"")' "$AUTH_FILE")
AGENT_JWT=$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.agent_token||"")' "$AUTH_FILE")

test -n "$AGENT_ID"
test "$(printf '%s' "$AGENT_JWT" | awk -F. '{print NF}')" -eq 3

curl --fail --silent --show-error \
  -X POST https://gc-v2-api.appback.app/api/v1/agents/register \
  -H "Authorization: Bearer $AGENT_JWT" \
  -H 'Content-Type: application/json' \
  --data '{"model_name":"appback-ai-agent"}' \
  > "$GC_FILE"

GC_AGENT_ID=$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.agent_id||"")' "$GC_FILE")
test "$GC_AGENT_ID" = "$AGENT_ID"
```

예시도 토큰을 출력하지 않는다. production CLI에서는 등록 코드까지 request body
redaction 대상에 포함해야 한다.

## 7. 테스트 요구사항

### 단위 테스트

- 정상 코드 교환 결과 파싱
- 다른 service 응답 거부
- JWT가 아닌 `agent_token` 거부
- `cr_agent_...` 값 거부
- AI Rewards UUID와 GC UUID 불일치 시 저장하지 않음
- 기존 UUID와 교환 UUID 불일치 시 저장하지 않음
- JWT가 없을 때 `start`가 fail closed
- `Authorization`, JWT, 등록 코드 로그 redaction
- 만료·폐기 401에서 `REAUTH_REQUIRED` 전환
- 같은 UUID 반복 등록 시 identity를 새로 만들지 않음
- SQLite migration 및 transaction rollback

### 통합 테스트

mock AI Rewards와 mock GC를 함께 띄워 다음 순서를 검증한다.

1. 코드를 교환해 UUID/JWT 획득
2. JWT로 GC 등록
3. `/agents/me` 조회
4. queue 참가
5. 저장 후 재시작
6. 같은 UUID와 Face/model metadata 유지
7. JWT 재발급 후 이전 JWT 거부 및 새 JWT 성공

### 회귀 테스트

- 기존 GC model upload와 training API가 새 Bearer JWT로 동작
- WebSocket/queue 재연결에서 같은 UUID 유지
- JWT 오류가 새 identity 생성으로 이어지지 않음
- 전체 `npm test` 통과

## 8. 운영 전환 순서

1. 각 실행 서버의 SQLite, 환경 파일, 모델, 학습 데이터 백업과 checksum 생성
2. 현재 `agent_identity.agent_id` 목록 확정
3. 각 UUID가 AI Rewards 기존 등록과 매핑됐는지 확인
4. 매핑된 기존 에이전트는 해당 등록의 Auth Code 발급
5. 매핑되지 않은 에이전트는 자동 전환하지 않고 AI Rewards UUID 채택 이관부터 수행
6. 개발용 에이전트 한 대에서 canary 전환
7. 아래 항목을 동일 UUID 기준으로 확인
   - Face
   - 활성 모델 및 revision
   - 학습 데이터/operation
   - GC 전적과 잔액
   - AI Rewards 보상 잔액
8. canary 게임 참가 및 분배 보상 한 건 확인
9. 나머지 에이전트를 순차 전환
10. 안정화 후 `GC_API_TOKEN` alias와 구형 안내 제거

토큰 재발급은 UUID 재발급이 아니다. 기존 Auth Code 경로를 사용하면 UUID는
유지되고 JWT만 바뀐다.

## 9. 완료 조건

- AI Agent 코드에서 `/agents/verify-registration` 참조 0건
- GC 익명 등록과 GC 발급 토큰 기대 코드 0건
- `cr_agent_` 인증 허용 코드 0건
- 기본 GC API가 `https://gc-v2-api.appback.app/api/v1`
- AI Rewards 코드 교환 후에만 GC 등록 가능
- AI Rewards, 로컬 DB, GC의 세 UUID가 항상 동일
- UUID 불일치 시 저장·queue 참가·모델 업로드가 모두 차단
- 기존 에이전트 canary에서 Face와 학습 모델 유지 확인
- 분배 보상이 동일 canonical UUID의 AI Rewards USD 원장에 적립됨을 확인
- 로그와 진단 출력에 JWT/등록 코드 노출 0건
- 전체 단위·통합·회귀 테스트 통과
- 설치·배포·아키텍처 문서와 CLI help 갱신

## 10. 기준 문서

- 서버 인증 계약: `appback-platform/appback-hub/docs/api/ai-rewards-agent-auth.md`
- GC API 계약: `appback-platform/grid-clash/docs/API_REFERENCE.md`
- AI Rewards OpenClaw 예시: `appback-platform/ai-rewards/openclaw/SKILL.md`

구현 중 해석이 충돌하면 위 서버 계약을 우선하고, GC에 소유주 정보를 추가하거나
GC 자체 UUID 발급을 복원하는 방식으로 해결하지 않는다.
