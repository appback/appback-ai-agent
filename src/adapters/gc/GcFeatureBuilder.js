/**
 * GcFeatureBuilder — Client-side port of server featureBuilder.js (v7.0)
 * Converts tick data into ONNX-compatible feature vectors.
 *
 * v7.0: 153-dim move features (map-size independent)
 *
 * Layout:
 *   [0..21]    Self features (22)
 *   [22..25]   Strategy (4)
 *   [26..115]  Opponents 6×15 = 90
 *   [116..119] Arena context (4)
 *   [120..143] 8-directional summary: 8 dirs × 3 (wall/enemy/powerup dist) = 24
 *   [144..147] Directional move validity (4)
 *   [148..151] Attack possible after move (4)
 *   [152]      Can attack from current pos (1)
 * Total: 153
 */

const WEAPON_SLUGS = ['sword', 'dagger', 'hammer', 'bow', 'spear']
const STRATEGY_MODES = ['aggressive', 'balanced', 'defensive']
const DIRECTIONS = [
  { dir: 'up',    dx: 0,  dy: -1 },
  { dir: 'down',  dx: 0,  dy: 1 },
  { dir: 'left',  dx: -1, dy: 0 },
  { dir: 'right', dx: 1,  dy: 0 }
]
const DIRECTIONS_8 = [
  { dx: 0,  dy: -1 },  // up
  { dx: 0,  dy: 1 },   // down
  { dx: -1, dy: 0 },   // left
  { dx: 1,  dy: 0 },   // right
  { dx: -1, dy: -1 },  // up-left
  { dx: 1,  dy: -1 },  // up-right
  { dx: -1, dy: 1 },   // down-left
  { dx: 1,  dy: 1 },   // down-right
]

class GcFeatureBuilder {
  constructor(equipment = {}) {
    this.weapons = equipment.weapons || {}
    this.armors = equipment.armors || {}
    this.terrain = null
    this.gridWidth = 8
    this.gridHeight = 8
  }

  setEquipment(equipment) {
    this.weapons = equipment.weapons || {}
    this.armors = equipment.armors || {}
  }

  /**
   * Cache terrain data from GET /games/:id/state response
   */
  setTerrain(arena) {
    if (!arena) return
    this.gridWidth = arena.width || arena.grid_width || 8
    this.gridHeight = arena.height || arena.grid_height || 8
    this.terrain = arena.terrain || null
  }

  clearTerrain() {
    this.terrain = null
    this.gridWidth = 8
    this.gridHeight = 8
  }

  /**
   * Enrich a tick agent object with weapon/armor details from equipment catalog
   */
  enrichAgent(agent) {
    const weaponSlug = agent.weapon?.slug || agent.weapon || 'sword'
    const armorSlug = agent.armor?.slug || agent.armor || 'leather'

    const weaponData = this._findWeapon(weaponSlug)
    const armorData = this._findArmor(armorSlug)

    return {
      ...agent,
      weapon: {
        slug: weaponSlug,
        damage: weaponData?.damage || 10,
        range: weaponData?.range || 1,
        rangeType: weaponData?.range_type || weaponData?.rangeType || 'adjacent',
        cooldown: weaponData?.cooldown || 0,
        atkSpeed: weaponData?.atk_speed || weaponData?.atkSpeed || 100,
        moveSpeed: weaponData?.move_speed || weaponData?.moveSpeed || 100,
      },
      armor: {
        slug: armorSlug,
        dmgReduction: armorData?.dmg_reduction || armorData?.dmgReduction || 0,
        evasion: armorData?.evasion || 0,
      },
      effectiveSpeed: agent.speed || agent.effectiveSpeed || 100,
      kills: agent.kills || 0,
      damageDealt: agent.damageDealt || agent.damage_dealt || 0,
      damageTaken: agent.damageTaken || agent.damage_taken || 0,
      survivedTicks: agent.survivedTicks || agent.survived_ticks || 0,
      actionAcc: agent.actionAcc || agent.action_acc || 0,
      idleTicks: agent.idleTicks || agent.idle_ticks || 0,
      score: agent.score || 0,
    }
  }

  _findWeapon(slug) {
    if (this.weapons[slug]) return this.weapons[slug]
    if (Array.isArray(this.weapons)) return this.weapons.find(w => w.slug === slug)
    return null
  }

  _findArmor(slug) {
    if (this.armors[slug]) return this.armors[slug]
    if (Array.isArray(this.armors)) return this.armors.find(a => a.slug === slug)
    return null
  }

  /**
   * Build 153-dim move feature vector (v7.0)
   */
  buildMoveFeatures(agent, gameState) {
    const gridW = this.gridWidth
    const gridH = this.gridHeight
    const terrain = this.terrain
    const living = gameState.agents.filter(a => a.alive)
    const shrinkPhase = gameState.shrinkPhase || gameState.shrink_phase || 0

    const vec = new Array(153).fill(0)
    let idx = 0

    // --- Self features (22) ---
    vec[idx++] = safe(agent.hp / agent.maxHp)                                     // 0
    vec[idx++] = safe(agent.x / gridW)                                             // 1
    vec[idx++] = safe(agent.y / gridH)                                             // 2
    vec[idx++] = safe((agent.weapon?.damage || 10) / 20)                           // 3
    vec[idx++] = safe((agent.weapon?.range || 1) / 5)                              // 4
    vec[idx++] = safe((agent.weapon?.cooldown || 0) / 10)                          // 5
    vec[idx++] = safe((agent.effectiveSpeed || 100) / 120)                         // 6
    vec[idx++] = safe((agent.effectiveSpeed || 100) / 120)                         // 7 (unified, same as 6)
    vec[idx++] = safe((agent.armor?.dmgReduction || 0) / 50)                       // 8
    vec[idx++] = safe((agent.armor?.evasion || 0) / 0.5)                           // 9
    vec[idx++] = safe((agent.score || 0) / 1000)                                   // 10
    vec[idx++] = safe((agent.kills || 0) / 8)                                      // 11
    vec[idx++] = safe((agent.damageTaken || 0) / 1000)                             // 12
    vec[idx++] = safe((agent.damageDealt || 0) / 1000)                             // 13
    vec[idx++] = safe((agent.survivedTicks || 0) / 300)                            // 14
    vec[idx++] = safe((agent.actionAcc || 0) / 200)                                // 15
    vec[idx++] = safe((agent.idleTicks || 0) / 30)                                 // 16
    // weapon one-hot (5)
    const wIdx = WEAPON_SLUGS.indexOf(agent.weapon?.slug || 'sword')
    for (let w = 0; w < 5; w++) vec[idx++] = wIdx === w ? 1 : 0                   // 17-21
    // idx = 22

    // --- Strategy (4) ---
    const modeIdx = STRATEGY_MODES.indexOf(agent.strategy?.mode || 'balanced')
    for (let m = 0; m < 3; m++) vec[idx++] = modeIdx === m ? 1 : 0                // 22-24
    vec[idx++] = safe((agent.strategy?.flee_threshold || 15) / 100)                // 25
    // idx = 26

    // --- Opponents 6×15 = 90 ---
    const enemies = gameState.agents
      .filter(a => a.alive && a.slot !== agent.slot)
      .sort((a, b) => manhattan(agent, a) - manhattan(agent, b))
      .slice(0, 6)

    for (let e = 0; e < 6; e++) {
      const startIdx = 26 + e * 15
      if (e >= enemies.length) { idx = startIdx + 15; continue }
      idx = startIdx
      const en = enemies[e]
      const dist = manhattan(agent, en)
      vec[idx++] = safe(en.hp / en.maxHp)                                          // +0
      vec[idx++] = safe(en.x / gridW)                                               // +1
      vec[idx++] = safe(en.y / gridH)                                               // +2
      vec[idx++] = safe((en.x - agent.x) / gridW)                                   // +3
      vec[idx++] = safe((en.y - agent.y) / gridH)                                   // +4
      vec[idx++] = safe(dist / 14)                                                   // +5
      vec[idx++] = safe((en.weapon?.damage || 10) / 20)                              // +6
      vec[idx++] = safe((en.weapon?.range || 1) / 5)                                 // +7
      vec[idx++] = safe((en.armor?.evasion || 0) / 0.5)                              // +8
      vec[idx++] = safe((en.kills || 0) / 8)                                         // +9
      vec[idx++] = inRange(agent, en) ? 1 : 0                                       // +10
      vec[idx++] = dist <= (agent.weapon?.range || 1) ? 1 : 0                       // +11
      vec[idx++] = en.alive ? 1 : 0                                                  // +12
      const enWIdx = WEAPON_SLUGS.indexOf(en.weapon?.slug || 'sword')
      vec[idx++] = safe((enWIdx + 1) / 5)                                           // +13
      vec[idx++] = en.weapon?.rangeType === 'ranged' ? 1 : 0                        // +14
    }
    idx = 116

    // --- Arena context (4) ---
    vec[idx++] = safe(shrinkPhase / 3)                                              // 116
    vec[idx++] = safe(living.length / 8)                                            // 117
    const nearPU = findNearestPowerup(agent, gameState.powerups)
    vec[idx++] = nearPU ? safe(manhattan(agent, nearPU) / 14) : 1.0                // 118
    vec[idx++] = 1.0  // 119 (reserved)
    // idx = 120

    // --- 8-directional summary (24) ---  [120..143]
    const maxDim = Math.max(gridW, gridH)
    const dirSummary = buildDirectionalSummary(agent, enemies, gameState.powerups, terrain, gridW, gridH, maxDim)
    for (let i = 0; i < 24; i++) vec[idx++] = dirSummary[i]
    // idx = 144

    // --- Directional move validity (4) ---  [144..147]
    const occupied = buildOccupiedSet(gameState, agent.slot)
    const moveValidity = []
    for (const { dx, dy } of DIRECTIONS) {
      const nx = agent.x + dx
      const ny = agent.y + dy
      const valid = nx >= 0 && nx < gridW && ny >= 0 && ny < gridH
        && getTerrain(terrain, nx, ny) !== 1
        && getTerrain(terrain, nx, ny) !== 2
        && !occupied.has(`${nx},${ny}`)
      moveValidity.push(valid ? 1 : 0)
      vec[idx++] = valid ? 1 : 0
    }
    // idx = 148

    // --- Attack possible after move (4) ---  [148..151]
    for (let d = 0; d < 4; d++) {
      if (!moveValidity[d]) {
        vec[idx++] = 0
      } else {
        const nx = agent.x + DIRECTIONS[d].dx
        const ny = agent.y + DIRECTIONS[d].dy
        const fakeAgent = { x: nx, y: ny, weapon: agent.weapon }
        const canAttack = enemies.some(en => inRange(fakeAgent, en))
        vec[idx++] = canAttack ? 1 : 0
      }
    }
    // idx = 152

    // --- Can attack from current position (1) ---  [152]
    vec[idx++] = enemies.some(en => inRange(agent, en)) ? 1 : 0
    // idx = 153

    return vec
  }

  /**
   * Build action mask for 5-class output: [stay, up, down, left, right]
   */
  buildActionMask(agent, gameState) {
    const gridW = this.gridWidth
    const gridH = this.gridHeight
    const terrain = this.terrain
    const occupied = buildOccupiedSet(gameState, agent.slot)

    const mask = [1, 0, 0, 0, 0]  // stay always valid

    for (let d = 0; d < DIRECTIONS.length; d++) {
      const { dx, dy } = DIRECTIONS[d]
      const nx = agent.x + dx
      const ny = agent.y + dy
      const valid = nx >= 0 && nx < gridW && ny >= 0 && ny < gridH
        && getTerrain(terrain, nx, ny) !== 1
        && getTerrain(terrain, nx, ny) !== 2
        && !occupied.has(`${nx},${ny}`)
      mask[d + 1] = valid ? 1 : 0
    }

    return mask
  }
}

// =============================================
// Utility functions
// =============================================

function safe(v) {
  if (!isFinite(v) || isNaN(v)) return 0
  return Math.max(-10, Math.min(10, v))
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

function getTerrain(terrain, x, y) {
  if (!terrain || !terrain[y]) return 0
  return terrain[y][x] || 0
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

function buildOccupiedSet(gameState, excludeSlot) {
  const occupied = new Set()
  for (const a of (gameState.agents || [])) {
    if (a.alive && a.slot !== excludeSlot) occupied.add(`${a.x},${a.y}`)
  }
  return occupied
}

/**
 * 8-directional ray-cast summary.
 * For each of 8 directions: [wall_dist, nearest_enemy_dist, nearest_powerup_dist]
 * Returns flat array of 24 values, all normalized to [0, 1].
 */
function buildDirectionalSummary(agent, enemies, powerups, terrain, gridW, gridH, maxDim) {
  const result = new Array(24).fill(1.0)

  // Assign entities to their closest octant
  const enemyBuckets = new Array(8).fill(null)  // {dist} per direction
  const puBuckets = new Array(8).fill(null)

  for (const en of enemies) {
    const dirIdx = getOctant(agent.x, agent.y, en.x, en.y)
    if (dirIdx < 0) continue
    const dist = manhattan(agent, en)
    if (!enemyBuckets[dirIdx] || dist < enemyBuckets[dirIdx]) {
      enemyBuckets[dirIdx] = dist
    }
  }

  if (powerups?.length) {
    for (const pu of powerups) {
      const dirIdx = getOctant(agent.x, agent.y, pu.x, pu.y)
      if (dirIdx < 0) continue
      const dist = manhattan(agent, pu)
      if (!puBuckets[dirIdx] || dist < puBuckets[dirIdx]) {
        puBuckets[dirIdx] = dist
      }
    }
  }

  for (let d = 0; d < 8; d++) {
    const base = d * 3
    const { dx, dy } = DIRECTIONS_8[d]

    // Ray-cast for wall distance
    let wallDist = 0
    let cx = agent.x + dx
    let cy = agent.y + dy
    while (cx >= 0 && cx < gridW && cy >= 0 && cy < gridH) {
      const t = getTerrain(terrain, cx, cy)
      if (t === 1 || t === 2) break
      wallDist++
      cx += dx
      cy += dy
    }
    result[base] = safe(wallDist / maxDim)

    // Nearest enemy in this octant
    result[base + 1] = enemyBuckets[d] != null ? safe(enemyBuckets[d] / (maxDim * 2)) : 1.0

    // Nearest powerup in this octant
    result[base + 2] = puBuckets[d] != null ? safe(puBuckets[d] / (maxDim * 2)) : 1.0
  }

  return result
}

/**
 * Get octant index (0-7) for direction from (ax,ay) to (bx,by).
 * Returns -1 if same position.
 * Octant order matches DIRECTIONS_8: up, down, left, right, up-left, up-right, down-left, down-right
 */
function getOctant(ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) return -1

  const adx = Math.abs(dx)
  const ady = Math.abs(dy)

  // Cardinal dominance: if one axis is >= 2× the other, treat as cardinal
  if (ady >= adx * 2) return dy < 0 ? 0 : 1       // up / down
  if (adx >= ady * 2) return dx < 0 ? 2 : 3       // left / right

  // Diagonal
  if (dx < 0 && dy < 0) return 4   // up-left
  if (dx > 0 && dy < 0) return 5   // up-right
  if (dx < 0 && dy > 0) return 6   // down-left
  return 7                          // down-right
}

module.exports = GcFeatureBuilder
