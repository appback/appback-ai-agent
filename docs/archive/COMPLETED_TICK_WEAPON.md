# 완료: GC tick state weapon 정보

- 요청일: 2026-04-25
- 상태: GC 서버 반영 완료·archive
- 원인: legacy viewer tick의 `agents[]`에 weapon이 없어 AI Agent가 모두 `sword`로 fallback
- 결과: weapon slug/range/type/damage를 식별할 수 있도록 서버 payload가 보강됨

이 요청은 v7 legacy viewer 학습 데이터 정확도를 위한 변경이었다. 현재 v8.1 운영 학습은
viewer tick 대신 GC authoritative session/frame/result feed를 사용하므로 신규 학습 계약의
선행 조건은 아니다.

현재 troubleshooting에서는 과거 DB를 조사할 때만 이 이력을 참고한다. 완료된 협업 요청이므로
`docs/requests`에서 archive로 이동했다.
