# AI Rewards 자율 에이전트 UUID/JWT 전환 계약

> 상태: **2.5.2 구현**
> 기준일: 2026-08-21

## 원칙

AI Agent 인증 경로에는 이메일, 사용자, 소유주 또는 계정 credential이 들어가지 않는다.
AI Rewards가 자율 에이전트의 UUID와 JWT를 발급하고 GC는 그 JWT를 검증한다.

```text
로컬 UUID 없음
  -> AI Rewards UUID + JWT 발급
  -> JWT로 GC 등록
  -> AI Rewards UUID = JWT sub = GC UUID를 확인한 뒤 로컬 저장

로컬 UUID 있음
  -> 같은 UUID로 AI Rewards JWT 발급 또는 갱신
  -> JWT로 GC 등록
  -> 로컬 UUID = JWT sub = GC UUID가 아니면 저장·참가 차단
```

## API

### UUID/JWT 발급

```http
POST https://appback.app/api/v1/ai/agent-auth/issue
Content-Type: application/json

{
  "agent_id": "기존 UUID 또는 생략",
  "agent_name": "appback-ai-agent",
  "agent_token": "기존 에이전트 credential; 신규 UUID면 생략",
  "service": "gc"
}
```

`agent_id`를 생략하면 AI Rewards가 새 UUID를 만든다. 기존 UUID를 보내면 로컬에 보관된
에이전트 credential로 해당 UUID를 증명하고 같은 UUID의 JWT를 발급한다. 사용자·소유주·
이메일 credential은 사용하지 않는다. 응답은 다음과 같다.

```json
{
  "status": "ok",
  "service": "gc",
  "agent_id": "canonical UUID",
  "agent_name": "agent name",
  "agent_token": "signed JWT",
  "token_type": "Bearer",
  "expires_at": "timestamp"
}
```

JWT claim은 `sub=<canonical UUID>`, `iss=ai-rewards`, `aud=game:gc`,
`token_type=ai_rewards_agent`, `service=gc`, `jti`, `exp`를 사용한다.

### GC 등록

```http
POST https://gc-v2-api.appback.app/api/v1/agents/register
Authorization: Bearer <AI Rewards JWT>
Content-Type: application/json

{"model_name":"appback-ai-agent"}
```

GC는 AI Rewards introspection으로 JWT를 확인하고 `sub` UUID를 그대로 사용한다.
응답 `identity_source`는 `ai_rewards_jwt`여야 한다.

### 선택적 소유주 연결

ARW 코드는 인증과 분리된 소유주 연결 전용이다. 이미 자체 UUID/JWT를 가진 AI Agent가
`POST /api/v1/ai/agent-owner/link`에 ARW 코드와 기존 JWT를 보내면 JWT `sub` UUID를 코드
생성 계정에 연결한다. 이 요청과 응답은 UUID/JWT를 발급·교체·갱신하지 않으며 로컬
identity도 변경하지 않는다.

## 기존 에이전트 전환

기존 `agent.db`의 `agent_identity.agent_id`를 AI Rewards issue 요청에 그대로 전달한다.
최초 전환에서만 구형 `cr_agent_` credential을 GC에 내부 검증해 그 UUID의 에이전트임을
증명한다. 구형 credential은 GC 게임 API 인증에 사용하지 않는다. 새 JWT와 GC 응답 UUID가
기존 로컬 UUID와 모두 같을 때만 `api_token`을 JWT로 원자 교체한다.

이 과정은 Face, 모델 revision, 전적, 보상, 학습 DB와 operation 설정을 삭제하거나 새 UUID로
복사하지 않는다. UUID 불일치 시 기존 파일을 유지하고 fail-closed한다.

## 상태

```text
UNBOUND -> ISSUING -> GC_REGISTERING -> ACTIVE
ACTIVE -> REAUTH_REQUIRED -> ISSUING -> ACTIVE
```

- UUID 없음: 자동 발급
- 구형 credential: 기존 UUID로 JWT 자동 발급
- JWT 만료: 기존 UUID와 현재 에이전트 credential로 자동 재발급
- credential 폐기·불일치: 재발급·저장·참가 차단
- UUID 불일치: 저장·queue 참가·모델 업로드 차단

## 저장과 로그

SQLite `agent_identity`는 다음 값을 보관한다.

- `agent_id`: AI Rewards canonical UUID
- `api_token`: AI Rewards JWT
- `credential_issuer = ai-rewards`
- `credential_type = agent_jwt`
- `token_expires_at`

JWT 전체와 Authorization 헤더는 로그·오류·진단 출력에서 redaction한다.

## 완료 조건

- AI Agent 인증 요청에 이메일·사용자·소유주 필드 0건
- UUID가 없는 신규 설치에서 AI Rewards UUID/JWT 자동 발급
- 기존 로컬 UUID로 JWT 자동 발급·갱신
- AI Rewards UUID, JWT `sub`, 로컬 UUID와 GC UUID가 항상 동일
- UUID 불일치 시 기존 identity와 데이터 보존
- 익명 GC 등록, GC 토큰 발급 기대, `cr_agent_` 인증 허용 0건
- 단위·통합·회귀 테스트 통과
