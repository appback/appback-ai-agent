# Troubleshooting

알려진 문제와 해결 방법.

---

## 설치 / 빌드

### `g++: unrecognized option '-std=c++20'`
- **원인:** gcc 11 이하 (RHEL 8 = gcc 8.5.0). `better-sqlite3` 11.x가 C++20 필요.
- **확인:** `g++ --version`
- **해결:** Node 20 + `better-sqlite3@9.6.0` override. [INSTALL.md#rhel-8](INSTALL.md) 참조.

### `prebuild-install` 실패
- **원인:** glibc < 2.29. prebuilt 바이너리 호환 안 됨.
- **확인:** `ldd --version`
- **해결:** 동일 (Node 20 + better-sqlite3 9.6.0)

### `npx: command not found` (pm2)
- **원인:** pm2가 nvm path 없이 실행됨.
- **해결:** 절대 경로 사용 또는 `--cwd` 지정.
  ```bash
  pm2 start "/home/USER/.nvm/versions/node/v22.22.0/bin/appback-ai-agent start" ...
  ```

---

## 실행

### 헬스 포트 충돌
- **증상:** `Port 9090 in use, trying 9091...`
- **해결:** 자동 처리 (정상 동작). 충돌 시 다음 포트(9091, 9092, ...) 사용.

### 매칭 큐에서 안 빠짐
- **증상:** `In matchmaking queue (Ns), waiting...`가 지속됨
- **원인:** 대기 인원 부족 또는 동일 IP 매칭 제한.
- **확인:**
  ```bash
  curl -s https://clash.appback.app/api/v1/queue/status -H "Authorization: Bearer $TOKEN"
  ```
- **참고:** [REQUEST_SAME_IP_MATCHING_BLOCK](../requests/REQUEST_SAME_IP_MATCHING_BLOCK.md)

### `Cancelled: pre-auth` (challenge submit 시)
- **원인:** 토큰 만료 또는 잘못된 등록.
- **해결:** `agent.db` 백업 후 `init` 다시 실행.

---

## 학습

### 자동 학습이 트리거되지 않음
- **확인:** `game_sessions` 카운트가 50의 배수인지.
  ```bash
  sqlite3 ~/data/agent.db "SELECT COUNT(*) FROM game_sessions WHERE result IS NOT NULL"
  ```
- 50, 100, 150... 정확히 그 시점에만 트리거됨. 게임 빠르게 끝나면 놓칠 수 있음.

### `Training failed (exit code 1)` — PyTorch onnx export
- **증상:**
  ```
  ModuleNotFoundError: No module named 'onnxscript'
  ```
- **원인:** PyTorch 2.11+의 onnx exporter가 `onnxscript` 의존.
- **해결:**
  ```bash
  ~/.venv-aiagent/bin/pip install onnxscript
  ```

### `Training failed` — 데이터 경로 불일치
- **원인:** 과거 버전 버그 (v2.0.x). 현재 버전에서는 해결됨.
- **확인:**
  ```bash
  ls -la ~/.nvm/versions/node/*/lib/node_modules/appback-ai-agent/training/data/raw/
  ```
  CSV/JSON이 있어야 함.

### 모델이 stay만 선택함
- **원인 후보:**
  1. 학습 데이터의 stay 라벨 비율 과다
  2. 휴리스틱이 공격 가능 상황에서도 이동 → 데이터 오염
- **확인:**
  ```bash
  sqlite3 ~/data/agent.db "
    SELECT json_extract(my_decision,'\$.action'), COUNT(*)
    FROM battle_ticks
    WHERE my_decision IS NOT NULL AND my_decision != ''
    GROUP BY 1"
  ```
- **해결:** v2.1.3 이상 사용 (휴리스틱 fix). 오염 데이터 정리 후 재학습.

---

## 모델 업로드

### `INVALID_MODEL` — 차원 불일치
- **증상:** `Inference failed with input dim N: Expected M`
- **원인:** featureBuilder 버전과 모델 input_dim 불일치.
- **해결:** 클라이언트와 서버 모두 같은 feature_version 사용.
  - v7.0 클라이언트 ↔ v7.0 서버 (153차원)
  - v6.0 클라이언트 ↔ v6.0 서버 (162차원)

### `VERSION_OUTDATED`
- **증상:** 서버가 구버전 모델 거부.
- **해결:**
  ```bash
  npm install -g appback-ai-agent@latest
  pm2 restart ai-agent
  ```

---

## 데이터

### 학습 데이터에 무기가 모두 sword
- **원인:** 과거 GC 서버 버그. tick state에 weapon 정보 누락.
- **상태:** [완료](../requests/REQUEST_TICK_WEAPON.md) — 서버 수정됨.
- **확인 (v2.2.0+):**
  ```bash
  sqlite3 ~/data/agent.db "
    SELECT json_extract(my_features,'\$[17]') as sword,
           json_extract(my_features,'\$[20]') as bow
    FROM battle_ticks
    WHERE my_features IS NOT NULL AND json_array_length(my_features)=153
    LIMIT 5"
  ```

### actionAcc가 항상 0
- 현재로는 정상. tick state에서 받는 normalized 값이 항상 0으로 보임 (서버에서 매번 reset 후 캡처).
- 학습에는 영향 없음.

---

## pm2

### 재부팅 후 에이전트 안 뜸
- `pm2 startup` 실행하고 출력된 sudo 명령 미실행 가능성.
- **확인:** `systemctl status pm2-USER`
- **해결:**
  ```bash
  pm2 startup
  # 출력된 sudo 명령어 실행
  pm2 save
  ```

### `Script not found` (Windows)
- **원인:** Windows pm2는 `.cmd` wrapper를 직접 실행 못 함.
- **해결:** node로 cli.js 직접 호출 또는 WSL에서 실행 (권장).
