const OBJECTIVE_KEYS = Object.freeze([
  'win',
  'top3',
  'kills',
  'damage',
  'survival',
  'powerup',
  'path_progress',
  'exploration',
  'anti_stuck',
])

const POLICY_KEYS = Object.freeze([
  'flee_hp_ratio',
  'max_chase_path',
  'replan_ticks',
  'target_persistence',
  'teacher_exploration_rate',
])

const EQUIPMENT_KEYS = Object.freeze([
  'damage',
  'range',
  'speed',
  'defense',
  'evasion',
  'skill',
  'history',
  'exploration',
])

const PRESETS = Object.freeze({
  balanced: preset(
    '균형형',
    '승리, 생존, 공격의 균형을 유지합니다.',
    [1.0, 0.7, 0.8, 0.8, 0.8, 0.6, 1.0, 0.4, 1.2],
    [0.28, 9, 3, 0.6, 0.03],
    [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.7]
  ),
  hunter: preset(
    '공격형',
    '약한 상대를 적극적으로 추격하고 피해와 처치를 우선합니다.',
    [1.0, 0.35, 1.5, 1.25, 0.4, 0.25, 0.85, 0.2, 1.0],
    [0.18, 12, 3, 0.8, 0.04],
    [2.0, 0.8, 1.1, 0.3, 0.3, 1.5, 0.8, 0.5]
  ),
  survivor: preset(
    '생존형',
    '불리한 전투를 피하고 안전 지역과 후반 생존을 우선합니다.',
    [1.2, 1.1, 0.35, 0.45, 1.6, 0.35, 1.1, 0.35, 1.4],
    [0.42, 5, 2, 0.45, 0.02],
    [0.35, 1.2, 0.8, 2.0, 1.7, 1.0, 1.1, 0.35]
  ),
  collector: preset(
    '수집형',
    '초반 파워업 확보와 유리한 장비 상태를 우선합니다.',
    [0.9, 0.6, 0.45, 0.55, 0.75, 1.7, 1.05, 0.65, 1.2],
    [0.3, 7, 3, 0.55, 0.05],
    [0.45, 0.6, 2.0, 0.5, 1.3, 0.6, 0.8, 1.2]
  ),
  navigator: preset(
    '탐색형',
    '목표 경로 단축, 미방문 지역 탐색, 반복 이동 방지를 우선합니다.',
    [0.9, 0.55, 0.35, 0.4, 0.85, 0.5, 1.7, 1.3, 1.9],
    [0.32, 8, 2, 0.5, 0.06],
    [0.35, 1.5, 2.0, 0.4, 1.2, 0.5, 0.7, 1.1]
  ),
})

function preset(label, description, objectiveValues, policyValues, equipmentValues) {
  const objective = {}
  const policy = {}
  const equipment = {}

  for (let i = 0; i < OBJECTIVE_KEYS.length; i++) {
    objective[OBJECTIVE_KEYS[i]] = objectiveValues[i]
  }
  for (let i = 0; i < POLICY_KEYS.length; i++) {
    policy[POLICY_KEYS[i]] = policyValues[i]
  }
  for (let i = 0; i < EQUIPMENT_KEYS.length; i++) {
    equipment[EQUIPMENT_KEYS[i]] = equipmentValues[i]
  }

  return Object.freeze({
    label,
    description,
    objective: Object.freeze(objective),
    policy: Object.freeze(policy),
    equipment: Object.freeze(equipment),
  })
}

module.exports = { PRESETS, OBJECTIVE_KEYS, POLICY_KEYS, EQUIPMENT_KEYS }
