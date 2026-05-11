# GC 서버 수정 요청 — Tick State에 weapon 정보 추가

> **상태:** 완료 (2026-04-25 GC 서버 배포 완료)


> 작성일: 2026-04-25
> 요청자: ai-agent 담당
> 우선순위: **높음** (학습 모델 정확도 직접 영향)

---

## 요약

WebSocket `tick` 이벤트 payload의 `agents[]` 객체에서 **`weapon` 정보가 누락**되어 있다. 이 때문에 ai-agent 클라이언트가 모든 에이전트(자기 자신 포함)의 무기를 인식하지 못하고, 학습 데이터에 무기 정보가 모두 sword로 fallback되어 기록되고 있다.

---

## 현상

### 1. 학습 데이터 분포

우리 에이전트 두 개의 최근 33만+ 틱 데이터에서 **100% sword**로 기록됨:

| 에이전트 | sword | 다른 무기 |
|---|---|---|
| `crab-54347eb5` | 157,188 (100%) | 0 |
| `crab-11ede365` | 174,065 (100%) | 0 |

### 2. 실제 사용 무기는 다양함

ai-agent 로그상 challenge 시 다양한 무기 사용 확인됨:
```
[gc-equip] Selected loadout: hammer + iron_plate
[gc-adapter] Challenge result: queued {applied:{weapon:"hammer"...}}

[gc-equip] Selected loadout: spear + leather
[gc-adapter] Challenge result: queued {applied:{weapon:"spear"...}}

[gc-equip] Selected loadout: bow + leather
[gc-adapter] Challenge result: queued {applied:{weapon:"bow"...}}
```

즉 클라이언트는 hammer, spear, bow 등을 사용했지만 학습 데이터엔 sword로 기록.

### 3. 원인

**`battleEngine.js`의 `buildTickState`** 함수가 weapon을 보내지 않음:

```javascript
// claw-clash/apps/api/services/battleEngine.js:936
function buildTickState(game, tick, phase, shrinkPhase, events, actionOrder) {
  return {
    ...
    agents: game.agents.map(a => ({
      slot: a.slot,
      hp: a.hp,
      maxHp: a.maxHp,
      x: a.x,
      y: a.y,
      alive: a.alive,
      score: a.score,
      kills: a.kills,
      armor: a.armor.slug,        // ← armor는 보냄
      buffs: a.buffs.map(b => b.type),
      bonus_damage: a.weapon.damage - a.weapon.baseDamage,
      bonus_hp: a.maxHp - config.startingHp,
      weapon_tier: a.weapon.enhanceTier || 0,
      armor_tier: a.armor.enhanceTier || 0,
      idle_ticks: a.idleTicks || 0
      // ← weapon.slug 누락!
    })),
    ...
  }
}
```

클라이언트의 `enrichAgent`는 `agent.weapon?.slug || agent.weapon || 'sword'` fallback이라 **weapon이 누락되면 모두 sword로 처리**한다.

---

## 영향

1. **학습 데이터 오염** — 모든 게임이 sword 데이터로 기록됨. bow/spear/hammer 패턴을 학습할 데이터가 없음
2. **모델 추론 오류** — ranged 무기(bow)를 들었는데 모델이 adjacent 패턴(거리 1로 접근)을 따라가서 공격 못함
3. **무기별 최적 전략 학습 불가능** — 모델이 항상 sword 가정하에 동작

---

## 요청 사항

### `buildTickState`에 weapon 정보 추가

```javascript
agents: game.agents.map(a => ({
  ...,
  weapon: a.weapon.slug,           // ← 추가 (필수)
  weapon_range: a.weapon.range,    // ← 추가 (선택, 정확한 사거리)
  weapon_range_type: a.weapon.rangeType,  // ← 추가 (필수: adjacent/pierce/ranged)
  weapon_damage: a.weapon.damage,  // ← 추가 (선택, 강화 보너스 반영)
  ...
})),
```

**최소 필요:** `weapon` (slug), `weapon_range_type`
**권장:** `weapon`, `weapon_range`, `weapon_range_type`, `weapon_damage`

### 위치

- 파일: `claw-clash/apps/api/services/battleEngine.js`
- 함수: `buildTickState` (line ~936)

---

## 검증 방법

수정 후:
1. ai-agent 로그에서 다양한 무기 사용 확인 (`Selected loadout: bow ...`)
2. SQLite `battle_ticks.state` 확인 — agents[].weapon 필드 존재 여부
3. 클라이언트 `my_features`의 weapon one-hot (idx 17~21) 분포 확인

---

## 참고

- ai-agent의 `enrichAgent`는 weapon이 객체(`{slug,...}`)거나 문자열 둘 다 받음
- equipment 카탈로그(`/equipment` API)에서 무기 상세 정보를 이미 가져오므로, slug만 있어도 클라이언트가 데미지/사거리/타입을 보강 가능
- `armor`는 이미 slug로 보내고 있으므로 weapon도 동일 패턴으로 추가하면 됨
