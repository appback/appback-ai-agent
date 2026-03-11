/**
 * GcFeatureBuilder — Client-side port of server featureBuilder.js (v6.0)
 * Converts tick data into ONNX-compatible feature vectors.
 *
 * v6.0: 162-dim move features (attack is automatic on server)
 *
 * Layout:
 *   [0..21]    Self features (22)
 *   [22..25]   Strategy (4)
 *   [26..115]  Opponents 6×15 = 90
 *   [116..119] Arena context (4)
 *   [120..144] 5×5 local terrain (25)
 *   [145..148] Directional move validity (4)
 *   [149..156] BFS path distances (8)
 *   [157..160] Attack possible after move (4)
 *   [161]      Can attack from current pos (1)
 * Total: 162
 */

const WEAPON_SLUGS = ['sword', 'dagger', 'hammer', 'bow', 'spear']
const STRATEGY_MODES = ['aggressive', 'balanced', 'defensive']
const DIRECTIONS = [
  { dir: 'up',    dx: 0,  dy: -1 },
  { dir: 'down',  dx: 0,  dy: 1 },
  { dir: 'left',  dx: -1, dy: 0 },
  { dir: 'right', dx: 1,  dy: 0 }
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
   * Build 162-dim move feature vector (v6.0)
   */
  buildMoveFeatures(agent, gameState) {
    const gridW = this.gridWidth
    const gridH = this.gridHeight
    const terrain = this.terrain
    const living = gameState.agents.filter(a => a.alive)
    const shrinkPhase = gameState.shrinkPhase || gameState.shrink_phase || 0

    const vec = new Array(162).fill(0)
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
    vec[idx++] = 1.0  // 119 (heal tile removed, reserved)
    // idx = 120

    // --- 5×5 local terrain (25) ---  [120..144]
    const occupied = buildOccupiedSet(gameState, agent.slot)
    for (let ly = -2; ly <= 2; ly++) {
      for (let lx = -2; lx <= 2; lx++) {
        const wx = agent.x + lx
        const wy = agent.y + ly
        if (wx < 0 || wx >= gridW || wy < 0 || wy >= gridH) {
          vec[idx++] = 0.33  // out of bounds = wall
        } else {
          vec[idx++] = safe(getTerrain(terrain, wx, wy) / 3)
        }
      }
    }
    // idx = 145

    // --- Directional move validity (4) ---  [145..148]
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
    // idx = 149

    // --- BFS path distances (8) ---  [149..156]
    const nearestEnemy = enemies[0] || null
    const maxDist = gridW + gridH

    // BFS to nearest enemy per direction [149..152]
    for (let d = 0; d < 4; d++) {
      if (!moveValidity[d] || !nearestEnemy) {
        vec[idx++] = 1.0
      } else {
        const nx = agent.x + DIRECTIONS[d].dx
        const ny = agent.y + DIRECTIONS[d].dy
        const dist = bfsDistance(nx, ny, nearestEnemy.x, nearestEnemy.y, terrain, gridW, gridH)
        vec[idx++] = safe(dist / maxDist)
      }
    }

    // BFS to nearest powerup per direction [153..156]
    for (let d = 0; d < 4; d++) {
      if (!moveValidity[d] || !nearPU) {
        vec[idx++] = 1.0
      } else {
        const nx = agent.x + DIRECTIONS[d].dx
        const ny = agent.y + DIRECTIONS[d].dy
        const dist = bfsDistance(nx, ny, nearPU.x, nearPU.y, terrain, gridW, gridH)
        vec[idx++] = safe(dist / maxDist)
      }
    }
    // idx = 157

    // --- Attack possible after move (4) ---  [157..160]
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
    // idx = 161

    // --- Can attack from current position (1) ---  [161]
    vec[idx++] = enemies.some(en => inRange(agent, en)) ? 1 : 0
    // idx = 162

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

function bfsDistance(sx, sy, tx, ty, terrain, gridW, gridH) {
  if (sx === tx && sy === ty) return 0

  const visited = new Set()
  visited.add(`${sx},${sy}`)
  const queue = [{ x: sx, y: sy, dist: 0 }]
  let head = 0

  while (head < queue.length) {
    const { x, y, dist } = queue[head++]
    for (const { dx, dy } of DIRECTIONS) {
      const nx = x + dx
      const ny = y + dy
      if (nx === tx && ny === ty) return dist + 1
      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue
      const t = getTerrain(terrain, nx, ny)
      if (t === 1 || t === 2) continue
      const key = `${nx},${ny}`
      if (visited.has(key)) continue
      visited.add(key)
      queue.push({ x: nx, y: ny, dist: dist + 1 })
    }
  }

  return gridW + gridH  // unreachable
}

module.exports = GcFeatureBuilder
