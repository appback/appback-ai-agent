const { STRATEGY_LABELS, WEAPON_ORDER } = require('../../config/gcStrategyV81Contract')

const CARDINALS = Object.freeze([
  { name: 'up', dx: 0, dy: -1 },
  { name: 'down', dx: 0, dy: 1 },
  { name: 'left', dx: -1, dy: 0 },
  { name: 'right', dx: 1, dy: 0 },
])
const OCTANTS = Object.freeze([
  ...CARDINALS,
  { name: 'up_left', dx: -1, dy: -1 },
  { name: 'up_right', dx: 1, dy: -1 },
  { name: 'down_left', dx: -1, dy: 1 },
  { name: 'down_right', dx: 1, dy: 1 },
])

class GcStrategyV81FeatureBuilder {
  build(input) {
    const game = canonicalGame(input.game)
    const agents = (input.agents || []).map(normalizeAgent)
    const selfIndex = integer(input.self_index ?? input.selfIndex, -1)
    if (selfIndex < 0 || selfIndex >= agents.length) throw new Error(`v8.1 self index out of range: ${selfIndex}`)
    const history = normalizeHistory(input.history, agents[selfIndex])
    const capabilities = input.capabilities || {}
    const candidates = input.candidates
      ? normalizeCandidates(input.candidates, agents, selfIndex)
      : buildCandidates(agents, selfIndex)
    validateCandidates(candidates, agents, selfIndex)

    const self = agents[selfIndex]
    const { width, height } = game
    const maxPath = Math.max(1, width + height - 2)
    const maxTicks = Math.max(1, integer(game.max_ticks, 300))
    const vector = new Array(214).fill(0)
    const set = (index, value) => { vector[index] = safe(value) }

    set(0, self.hp / Math.max(1, self.max_hp))
    set(1, self.x / width)
    set(2, self.y / height)
    set(3, averageDamage(self) / 20)
    set(4, self.range / 5)
    set(5, self.armor_reduction / 20)
    set(6, self.bonus_defense / 20)
    set(7, self.evasion / 0.5)
    set(8, self.speed / 120)
    set(9, self.action_acc / 100)
    set(10, self.score / 1000)
    set(11, self.kills / 7)
    set(12, self.damage_taken / 1000)
    set(13, self.damage_dealt / 1000)
    set(14, self.survived_ticks / maxTicks)
    set(15, self.alive ? 1 : 0)
    WEAPON_ORDER.forEach((weapon, index) => set(16 + index, self.weapon === weapon ? 1 : 0))
    const rangeType = self.range_type || 'adjacent'
    set(21, rangeType === 'adjacent' ? 1 : 0)
    set(22, rangeType === 'ranged' ? 1 : 0)
    set(23, rangeType === 'pierce' ? 1 : 0)
    set(24, aliveCandidateCount(agents, candidates) / 7)
    set(25, integer(input.tick, 0) / maxTicks)

    const paths = new Map()
    for (const candidate of candidates) {
      const agent = agents[candidate.agentIndex]
      const base = 26 + candidate.candidate * 16
      set(base, agent.alive ? 1 : 0)
      set(base + 1, agent.hp / Math.max(1, agent.max_hp))
      set(base + 2, (agent.x - self.x) / width)
      set(base + 3, (agent.y - self.y) / height)
      set(base + 4, manhattan(self, agent) / maxPath)
      const path = agent.alive ? shortestAttackPath(game, agents, selfIndex, candidate.agentIndex) : null
      if (path) {
        paths.set(candidate.candidate, path)
        set(base + 5, path.distance / maxPath)
        set(base + 6, 1)
      } else {
        set(base + 5, 1)
      }
      set(base + 7, averageDamage(agent) / 20)
      set(base + 8, agent.range / 5)
      set(base + 9, (agent.armor_reduction + agent.bonus_defense) / 20)
      set(base + 10, agent.evasion / 0.5)
      set(base + 11, agent.action_acc / 100)
      set(base + 12, agent.alive && inAttackRange(agent, self) ? 1 : 0)
      set(base + 13, agent.alive && inAttackRange(self, agent) ? 1 : 0)
      set(base + 14, agent.kills / 7)
      set(base + 15, weaponCode(agent.weapon))
    }

    if (capabilities.shrink_safe_zone) set(138, number(game.shrink_phase_ratio, 0))
    set(139, agents.filter(agent => agent.alive).length / 8)
    set(140, 1)
    set(141, 1)
    fillDirectional(vector, game, agents, selfIndex, candidates)

    const moveMask = buildMoveMask(game, agents, selfIndex)
    let validMoves = 0
    moveMask.slice(1).forEach((allowed, index) => {
      set(166 + index, allowed)
      validMoves += allowed
    })
    const reachable = reachableCells(game, agents, selfIndex)
    set(170, reachable.cells.length / Math.max(1, reachable.walkable))
    set(171, reachable.walkable / Math.max(1, width * height))
    set(172, validMoves <= 1 ? 1 : 0)

    set(173, (self.hp - history.previous_hp) / Math.max(1, self.max_hp))
    set(174, (self.score - history.previous_score) / 1000)
    set(175, (self.damage_dealt - history.previous_damage_dealt) / 1000)
    set(176, (self.damage_taken - history.previous_damage_taken) / 1000)
    const previousIndex = STRATEGY_LABELS.indexOf(history.previous_strategy)
    if (previousIndex >= 0) set(177 + previousIndex, 1)
    set(188, history.same_position_streak / 8)
    set(189, history.no_progress_actions / 16)
    set(190, visitCount(history.visits, self.x, self.y) / 8)
    set(191, history.two_cycle_count / 4)
    set(192, history.three_cycle_count / 4)
    set(193, history.selected_target_streak / 8)

    const strategyMask = buildStrategyMask(agents, selfIndex, candidates, history, capabilities, reachable.cells, paths)
    strategyMask.forEach((allowed, index) => set(194 + index, allowed))

    let aliveCandidates = 0
    let reachableCandidates = 0
    let attackableNow = 0
    let currentThreats = 0
    let minPath = maxPath
    let bestFinish = 0
    let maxThreatDamage = 0
    for (const candidate of candidates) {
      const agent = agents[candidate.agentIndex]
      if (!agent.alive) continue
      aliveCandidates++
      const path = paths.get(candidate.candidate)
      if (path) {
        reachableCandidates++
        minPath = Math.min(minPath, path.distance)
        bestFinish = Math.max(bestFinish, 1 - agent.hp / Math.max(1, agent.max_hp))
      }
      if (inAttackRange(self, agent)) attackableNow++
      if (inAttackRange(agent, self)) {
        currentThreats++
        maxThreatDamage = Math.max(maxThreatDamage, averageDamage(agent) / Math.max(1, self.max_hp))
      }
    }
    set(205, aliveCandidates / 7)
    set(206, reachableCandidates / 7)
    set(207, attackableNow / 7)
    set(208, currentThreats / 7)
    set(209, reachableCandidates === 0 ? 1 : minPath / maxPath)
    set(210, bestFinish)
    set(211, maxThreatDamage)
    const minimumThreats = reachable.cells.reduce((minimum, cell) =>
      Math.min(minimum, threatCountAt(agents, selfIndex, candidates, cell)), currentThreats)
    set(212, (currentThreats - minimumThreats) / 7)
    const nonCurrent = reachable.cells.filter(cell => cell.distance !== 0)
    if (nonCurrent.length > 0) {
      const minimumVisits = Math.min(...nonCurrent.map(cell => Math.min(8, visitCount(history.visits, cell.x, cell.y))))
      set(213, 1 - minimumVisits / 8)
    }

    return {
      featureVector: vector,
      strategyMask,
      candidates: candidates.map(({ candidate, slot }) => ({ candidate, slot })),
      candidateSlots: candidates.map(candidate => candidate.slot),
    }
  }
}

function buildCandidates(agents, selfIndex) {
  return agents.map((agent, agentIndex) => ({ agentIndex, slot: agent.slot }))
    .filter(candidate => candidate.agentIndex !== selfIndex)
    .sort((left, right) => left.slot - right.slot || left.agentIndex - right.agentIndex)
    .slice(0, 7)
    .map((candidate, index) => ({ ...candidate, candidate: index }))
}

function normalizeCandidates(candidates, agents, selfIndex) {
  return candidates.map((candidate, index) => {
    const agentIndex = candidate.agentIndex ?? candidate.agent_index ?? agents.findIndex(agent => agent.slot === candidate.slot)
    return { candidate: candidate.candidate ?? index, agentIndex, slot: candidate.slot }
  }).filter(candidate => candidate.agentIndex !== selfIndex)
}

function validateCandidates(candidates, agents, selfIndex) {
  const slots = new Set()
  candidates.forEach((candidate, index) => {
    if (candidate.candidate !== index || index >= 7) throw new Error('v8.1 candidates must be dense and ordered')
    if (candidate.agentIndex < 0 || candidate.agentIndex >= agents.length || candidate.agentIndex === selfIndex) {
      throw new Error(`v8.1 candidate agent index is invalid: ${candidate.agentIndex}`)
    }
    if (candidate.slot !== agents[candidate.agentIndex].slot || slots.has(candidate.slot)) {
      throw new Error(`v8.1 candidate slot is invalid: ${candidate.slot}`)
    }
    if (index > 0 && candidates[index - 1].slot >= candidate.slot) throw new Error('v8.1 candidate slots must increase')
    slots.add(candidate.slot)
  })
}

function buildStrategyMask(agents, selfIndex, candidates, history, capabilities, cells, paths) {
  const mask = new Array(11).fill(0)
  mask[0] = 1
  if (aliveCandidateCount(agents, candidates) > 0 && bestFleeGoal(agents, selfIndex, candidates, history, cells).distance > 0) mask[1] = 1
  if (capabilities.powerups) mask[2] = 0
  if (cells.some(cell => cell.distance > 0)) mask[3] = 1
  for (const candidate of candidates) {
    if (agents[candidate.agentIndex].alive && paths.has(candidate.candidate)) mask[4 + candidate.candidate] = 1
  }
  return mask
}

function reachableCells(game, agents, selfIndex) {
  let walkable = 0
  for (let y = 0; y < game.height; y++) {
    for (let x = 0; x < game.width; x++) if (!blocked(game.terrain, x, y)) walkable++
  }
  const self = agents[selfIndex]
  const occupied = new Set(agents.filter((agent, index) => index !== selfIndex && agent.alive).map(agent => key(agent.x, agent.y)))
  const cells = [{ x: self.x, y: self.y, firstAction: 'stay', distance: 0, discovery: 0 }]
  const seen = new Set([key(self.x, self.y)])
  for (let cursor = 0; cursor < cells.length; cursor++) {
    const current = cells[cursor]
    for (const direction of CARDINALS) {
      const x = current.x + direction.dx
      const y = current.y + direction.dy
      const positionKey = key(x, y)
      if (x < 0 || y < 0 || x >= game.width || y >= game.height || seen.has(positionKey) || occupied.has(positionKey) || blocked(game.terrain, x, y)) continue
      seen.add(positionKey)
      cells.push({
        x, y,
        firstAction: current.distance === 0 ? direction.name : current.firstAction,
        distance: current.distance + 1,
        discovery: seen.size - 1,
      })
    }
  }
  return { cells, walkable }
}

function shortestAttackPath(game, agents, selfIndex, targetIndex) {
  if (targetIndex < 0 || targetIndex >= agents.length || !agents[targetIndex].alive) return null
  const { cells } = reachableCells(game, agents, selfIndex)
  for (const cell of cells) {
    if (inAttackRange({ ...agents[selfIndex], x: cell.x, y: cell.y }, agents[targetIndex])) return cell
  }
  return null
}

function bestFleeGoal(agents, selfIndex, candidates, history, cells) {
  return cells.reduce((best, cell) => fleeLess(agents, selfIndex, candidates, history, cell, best) ? cell : best)
}

function fleeLess(agents, selfIndex, candidates, history, left, right) {
  const leftThreats = threatCountAt(agents, selfIndex, candidates, left)
  const rightThreats = threatCountAt(agents, selfIndex, candidates, right)
  if (leftThreats !== rightThreats) return leftThreats < rightThreats
  const leftDistance = nearestEnemyDistance(agents, candidates, left)
  const rightDistance = nearestEnemyDistance(agents, candidates, right)
  if (leftDistance !== rightDistance) return leftDistance > rightDistance
  const leftVisits = visitCount(history.visits, left.x, left.y)
  const rightVisits = visitCount(history.visits, right.x, right.y)
  if (leftVisits !== rightVisits) return leftVisits < rightVisits
  if (left.distance !== right.distance) return left.distance < right.distance
  return left.discovery < right.discovery
}

function threatCountAt(agents, selfIndex, candidates, position) {
  const self = { ...agents[selfIndex], x: position.x, y: position.y }
  return candidates.filter(candidate => agents[candidate.agentIndex].alive && inAttackRange(agents[candidate.agentIndex], self)).length
}

function nearestEnemyDistance(agents, candidates, position) {
  const distances = candidates.filter(candidate => agents[candidate.agentIndex].alive)
    .map(candidate => manhattan(position, agents[candidate.agentIndex]))
  return distances.length > 0 ? Math.min(...distances) : 0
}

function fillDirectional(vector, game, agents, selfIndex, candidates) {
  const self = agents[selfIndex]
  const maxDimension = Math.max(1, game.width, game.height)
  const maxPath = Math.max(1, game.width + game.height - 2)
  OCTANTS.forEach((direction, index) => {
    let x = self.x + direction.dx
    let y = self.y + direction.dy
    let free = 0
    while (x >= 0 && y >= 0 && x < game.width && y < game.height && !blocked(game.terrain, x, y)) {
      free++
      x += direction.dx
      y += direction.dy
    }
    vector[142 + index * 3] = safe(free / maxDimension)
    vector[143 + index * 3] = 1
  })
  for (const candidate of candidates) {
    const agent = agents[candidate.agentIndex]
    if (!agent.alive) continue
    const direction = octant(self, agent)
    if (direction < 0) continue
    const distance = safe(manhattan(self, agent) / maxPath)
    const distanceIndex = 143 + direction * 3
    if (vector[distanceIndex] === 1 || distance < vector[distanceIndex]) vector[distanceIndex] = distance
    vector[144 + direction * 3] = 1
  }
}

function buildMoveMask(game, agents, selfIndex) {
  const self = agents[selfIndex]
  const occupied = new Set(agents.filter((agent, index) => index !== selfIndex && agent.alive).map(agent => key(agent.x, agent.y)))
  return [1, ...CARDINALS.map(direction => {
    const x = self.x + direction.dx
    const y = self.y + direction.dy
    return x >= 0 && y >= 0 && x < game.width && y < game.height && !blocked(game.terrain, x, y) && !occupied.has(key(x, y)) ? 1 : 0
  })]
}

function inAttackRange(attacker, target) {
  const dx = Math.abs(attacker.x - target.x)
  const dy = Math.abs(attacker.y - target.y)
  const distance = dx + dy
  const range = Math.max(1, integer(attacker.range, 1))
  const rangeType = attacker.range_type || 'adjacent'
  if (rangeType === 'ranged') return distance >= 2 && distance <= range
  if (rangeType === 'pierce') return distance >= 1 && distance <= range && (dx === 0 || dy === 0)
  return distance >= 1 && distance <= range
}

function octant(left, right) {
  const dx = right.x - left.x
  const dy = right.y - left.y
  if (dx === 0 && dy < 0) return 0
  if (dx === 0 && dy > 0) return 1
  if (dy === 0 && dx < 0) return 2
  if (dy === 0 && dx > 0) return 3
  if (dx < 0 && dy < 0) return 4
  if (dx > 0 && dy < 0) return 5
  if (dx < 0 && dy > 0) return 6
  if (dx > 0 && dy > 0) return 7
  return -1
}

function normalizeAgent(agent) {
  return {
    slot: integer(agent.slot, 0), x: integer(agent.x, 0), y: integer(agent.y, 0),
    hp: number(agent.hp, 0), max_hp: number(agent.max_hp ?? agent.maxHp, 1), alive: agent.alive !== false,
    weapon: String(agent.weapon || ''), range_type: String(agent.range_type ?? agent.rangeType ?? ''),
    damage_min: number(agent.damage_min ?? agent.damageMin, 0), damage_max: number(agent.damage_max ?? agent.damageMax, 0),
    range: number(agent.range, 1), armor_reduction: number(agent.armor_reduction ?? agent.armorReduction, 0),
    bonus_defense: number(agent.bonus_defense ?? agent.bonusDefense, 0), evasion: number(agent.evasion, 0),
    speed: number(agent.speed ?? agent.effective_speed ?? agent.effectiveSpeed, 0), action_acc: number(agent.action_acc ?? agent.actionAcc, 0),
    score: number(agent.score, 0), kills: number(agent.kills, 0), damage_dealt: number(agent.damage_dealt ?? agent.damageDealt, 0),
    damage_taken: number(agent.damage_taken ?? agent.damageTaken, 0), survived_ticks: number(agent.survived_ticks ?? agent.survivedTicks, 0),
  }
}

function normalizeHistory(history = {}, self) {
  return {
    previous_hp: number(history.previous_hp ?? history.previousHP, self.hp),
    previous_score: number(history.previous_score ?? history.previousScore, self.score),
    previous_damage_dealt: number(history.previous_damage_dealt ?? history.previousDamageDealt, self.damage_dealt),
    previous_damage_taken: number(history.previous_damage_taken ?? history.previousDamageTaken, self.damage_taken),
    previous_strategy: String(history.previous_strategy ?? history.previousStrategy ?? ''),
    same_position_streak: number(history.same_position_streak ?? history.samePositionStreak, 0),
    no_progress_actions: number(history.no_progress_actions ?? history.noProgressActions, 0),
    two_cycle_count: number(history.two_cycle_count ?? history.twoCycleCount, 0),
    three_cycle_count: number(history.three_cycle_count ?? history.threeCycleCount, 0),
    selected_target_streak: number(history.selected_target_streak ?? history.selectedTargetStreak, 0),
    visits: Array.isArray(history.visits) ? history.visits : [],
  }
}

function canonicalGame(game = {}) {
  const width = Math.max(1, integer(game.grid_width ?? game.width, 8))
  const height = Math.max(1, integer(game.grid_height ?? game.height, 8))
  const source = Array.isArray(game.terrain) ? game.terrain : []
  const terrain = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => integer(source[y]?.[x], 0)))
  return { ...game, width, height, terrain }
}

function visitCount(visits, x, y) {
  const found = visits.find(visit => integer(visit.x ?? visit.X, -1) === x && integer(visit.y ?? visit.Y, -1) === y)
  return found ? number(found.count ?? found.Count, 0) : 0
}

function blocked(terrain, x, y) { return terrain[y]?.[x] === 1 || terrain[y]?.[x] === 2 }
function aliveCandidateCount(agents, candidates) { return candidates.filter(candidate => agents[candidate.agentIndex].alive).length }
function averageDamage(agent) { return (agent.damage_min + agent.damage_max) / 2 }
function weaponCode(weapon) { const index = WEAPON_ORDER.indexOf(weapon); return index < 0 ? 0 : (index + 1) / WEAPON_ORDER.length }
function manhattan(left, right) { return Math.abs(left.x - right.x) + Math.abs(left.y - right.y) }
function key(x, y) { return `${x},${y}` }
function safe(value) { return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0 }
function number(value, fallback) { return typeof value === 'number' && Number.isFinite(value) ? value : fallback }
function integer(value, fallback) { return Number.isInteger(value) ? value : fallback }

module.exports = {
  GcStrategyV81FeatureBuilder,
  CARDINALS,
  buildCandidates,
  inAttackRange,
  reachableCells,
  shortestAttackPath,
}
