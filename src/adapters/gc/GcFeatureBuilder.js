/**
 * GcFeatureBuilder — Client-side port of server featureBuilder.js
 * Converts tick data into ONNX-compatible feature vectors.
 *
 * Move features: 120 dims
 * Attack features: 31 dims
 */

const WEAPON_SLUGS = ['sword', 'dagger', 'hammer', 'bow', 'spear']
const STRATEGY_MODES = ['aggressive', 'balanced', 'defensive']

class GcFeatureBuilder {
  constructor(equipment = {}) {
    // equipment catalog for enriching tick data
    this.weapons = equipment.weapons || {}
    this.armors = equipment.armors || {}
  }

  setEquipment(equipment) {
    this.weapons = equipment.weapons || {}
    this.armors = equipment.armors || {}
  }

  /**
   * Build 120-dim move feature vector
   */
  buildMoveFeatures(agent, gameState) {
    const gridW = gameState.gridWidth || 8
    const gridH = gameState.gridHeight || 8
    const living = gameState.agents.filter(a => a.alive)
    const shrinkPhase = gameState.shrinkPhase || 0

    const vec = new Array(120).fill(0)
    let idx = 0

    // Self features (22)
    vec[idx++] = safe(agent.hp / agent.maxHp)
    vec[idx++] = safe(agent.x / gridW)
    vec[idx++] = safe(agent.y / gridH)
    vec[idx++] = safe((agent.weapon?.damage || 10) / 20)
    vec[idx++] = safe((agent.weapon?.range || 1) / 5)
    vec[idx++] = safe((agent.weapon?.cooldown || 0) / 10)
    vec[idx++] = safe((agent.effectiveAtkSpeed || 100) / 120)
    vec[idx++] = safe((agent.effectiveMoveSpeed || 100) / 120)
    vec[idx++] = safe((agent.armor?.dmgReduction || 0) / 50)
    vec[idx++] = safe((agent.armor?.evasion || 0) / 0.5)
    vec[idx++] = safe((agent.score || 0) / 1000)
    vec[idx++] = safe((agent.kills || 0) / 8)
    vec[idx++] = safe((agent.damageTaken || 0) / 1000)
    vec[idx++] = safe((agent.damageDealt || 0) / 1000)
    vec[idx++] = safe((agent.survivedTicks || 0) / 300)
    vec[idx++] = safe((agent.atkAcc || 0) / 200)
    vec[idx++] = safe((agent.moveAcc || 0) / 100)
    // weapon one-hot (5)
    const wIdx = WEAPON_SLUGS.indexOf(agent.weapon?.slug || 'sword')
    for (let w = 0; w < 5; w++) vec[idx++] = wIdx === w ? 1 : 0

    // Strategy (4)
    const modeIdx = STRATEGY_MODES.indexOf(agent.strategy?.mode || 'balanced')
    for (let m = 0; m < 3; m++) vec[idx++] = modeIdx === m ? 1 : 0
    vec[idx++] = safe((agent.strategy?.flee_threshold || 15) / 100)

    // Opponents 6×15 = 90
    const enemies = gameState.agents
      .filter(a => a.alive && a.slot !== agent.slot)
      .sort((a, b) => manhattan(agent, a) - manhattan(agent, b))
      .slice(0, 6)

    for (let e = 0; e < 6; e++) {
      const start = 26 + e * 15
      if (e >= enemies.length) { idx = start + 15; continue }
      idx = start
      const en = enemies[e]
      const dist = manhattan(agent, en)
      vec[idx++] = safe(en.hp / en.maxHp)
      vec[idx++] = safe(en.x / gridW)
      vec[idx++] = safe(en.y / gridH)
      vec[idx++] = safe((en.x - agent.x) / gridW)
      vec[idx++] = safe((en.y - agent.y) / gridH)
      vec[idx++] = safe(dist / 14)
      vec[idx++] = safe((en.weapon?.damage || 10) / 20)
      vec[idx++] = safe((en.weapon?.range || 1) / 5)
      vec[idx++] = safe((en.armor?.evasion || 0) / 0.5)
      vec[idx++] = safe((en.kills || 0) / 8)
      vec[idx++] = inRange(agent, en) ? 1 : 0
      vec[idx++] = dist <= (agent.weapon?.range || 1) ? 1 : 0
      vec[idx++] = en.alive ? 1 : 0
      const enWIdx = WEAPON_SLUGS.indexOf(en.weapon?.slug || 'sword')
      vec[idx++] = safe((enWIdx + 1) / 5)
      vec[idx++] = en.weapon?.rangeType === 'ranged' ? 1 : 0
    }
    idx = 116

    // Arena context (4)
    vec[idx++] = safe(shrinkPhase / 3)
    vec[idx++] = safe(living.length / 8)
    const nearPU = findNearestPowerup(agent, gameState.powerups)
    vec[idx++] = nearPU ? safe(manhattan(agent, nearPU) / 14) : 1.0
    vec[idx++] = 1.0 // heal tile (removed from game)

    return vec
  }

  /**
   * Build 31-dim attack feature vector
   */
  buildAttackFeatures(agent, target, gameState) {
    const gridW = gameState.gridWidth || 8
    const gridH = gameState.gridHeight || 8
    const living = gameState.agents.filter(a => a.alive)
    const maxTicks = gameState.maxTicks || 300
    const tick = gameState.tick || 0

    const vec = new Array(31).fill(0)
    let idx = 0

    // Self (10)
    vec[idx++] = safe(agent.hp / agent.maxHp)
    vec[idx++] = safe((agent.weapon?.damage || 10) / 20)
    vec[idx++] = safe((agent.weapon?.range || 1) / 5)
    vec[idx++] = safe((agent.weapon?.cooldown || 0) / 10)
    vec[idx++] = safe((agent.atkAcc || 0) / 200)
    vec[idx++] = safe((agent.kills || 0) / 8)
    vec[idx++] = safe((agent.score || 0) / 1000)
    vec[idx++] = safe((agent.armor?.dmgReduction || 0) / 50)
    const wIdx = WEAPON_SLUGS.indexOf(agent.weapon?.slug || 'sword')
    vec[idx++] = safe((wIdx + 1) / 5)
    vec[idx++] = agent.weapon?.rangeType === 'ranged' ? 1 : 0

    // Target (15)
    const dist = manhattan(agent, target)
    vec[idx++] = safe(target.hp / target.maxHp)
    vec[idx++] = safe(dist / 14)
    vec[idx++] = safe((target.x - agent.x) / gridW)
    vec[idx++] = safe((target.y - agent.y) / gridH)
    vec[idx++] = safe((target.weapon?.damage || 10) / 20)
    vec[idx++] = safe((target.weapon?.range || 1) / 5)
    vec[idx++] = safe((target.armor?.evasion || 0) / 0.5)
    vec[idx++] = safe((target.armor?.dmgReduction || 0) / 50)
    vec[idx++] = safe((target.kills || 0) / 8)
    vec[idx++] = inRange(agent, target) ? 1 : 0
    vec[idx++] = safe(target.hp / target.maxHp)
    const tWIdx = WEAPON_SLUGS.indexOf(target.weapon?.slug || 'sword')
    vec[idx++] = safe((tWIdx + 1) / 5)
    vec[idx++] = target.weapon?.rangeType === 'ranged' ? 1 : 0
    vec[idx++] = target.weapon?.rangeType === 'pierce' ? 1 : 0
    vec[idx++] = safe((target.score || 0) / 1000)

    // Context (6)
    const shrinkPhase = getShrinkPhase(tick, maxTicks)
    vec[idx++] = safe(living.length / 8)
    vec[idx++] = safe(shrinkPhase / 3)
    vec[idx++] = safe(tick / maxTicks)
    vec[idx++] = agent.hp < agent.maxHp * 0.3 ? 1 : 0
    vec[idx++] = target.hp < target.maxHp * 0.3 ? 1 : 0
    vec[idx++] = living.length <= 2 ? 1 : 0

    return vec
  }
}

function safe(v) {
  if (!isFinite(v) || isNaN(v)) return 0
  return Math.max(-10, Math.min(10, v))
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

function inRange(agent, target) {
  const dx = Math.abs(agent.x - target.x)
  const dy = Math.abs(agent.y - target.y)
  const dist = dx + dy
  const range = agent.weapon?.range || 1
  switch (agent.weapon?.rangeType) {
    case 'adjacent': return dist >= 1 && dist <= range
    case 'pierce': return (dx === 0 && dy >= 1 && dy <= range) || (dy === 0 && dx >= 1 && dx <= range)
    case 'ranged': return dist >= 2 && dist <= range
    default: return dist >= 1 && dist <= range
  }
}

function findNearestPowerup(agent, powerups) {
  if (!powerups?.length) return null
  let best = null, bestDist = Infinity
  for (const p of powerups) {
    const d = manhattan(agent, p)
    if (d < bestDist) { bestDist = d; best = p }
  }
  return best
}

function getShrinkPhase(tick, maxTicks) {
  const pct = tick / maxTicks
  if (pct >= 0.8) return 2
  if (pct >= 0.6) return 1
  return 0
}

module.exports = GcFeatureBuilder
