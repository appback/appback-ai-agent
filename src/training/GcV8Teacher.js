const crypto = require('crypto')

const DIRECTIONS = Object.freeze([
  { action: 'stay', dx: 0, dy: 0 },
  { action: 'up', dx: 0, dy: -1 },
  { action: 'down', dx: 0, dy: 1 },
  { action: 'left', dx: -1, dy: 0 },
  { action: 'right', dx: 1, dy: 0 },
])

class GcV8Teacher {
  constructor(profile) {
    this.profile = profile || {}
    this.objective = this.profile.objective || {}
    this.policy = this.profile.policy || {}
  }

  buildSample(frame, session, result = null) {
    const state = frame.state || {}
    const agents = Array.isArray(state.agents) ? state.agents : []
    const me = agents.find(agent => agent.slot === frame.agent.slot)
    if (!me) throw new Error(`teacher state does not contain agent slot ${frame.agent.slot}`)

    const arena = session?.manifest?.arena || session?.arena || {}
    const terrain = Array.isArray(arena.terrain) ? arena.terrain : []
    const width = positiveInteger(arena.width, terrain[0]?.length || 8)
    const height = positiveInteger(arena.height, terrain.length || 8)
    const mask = frame.input.action_mask.map(value => value ? 1 : 0)
    const enemies = agents.filter(agent => agent.alive && agent.slot !== me.slot)
    const visits = visitMap(frame.history_before?.visits)
    const occupied = new Set(enemies.map(agent => key(agent.x, agent.y)))
    const context = { terrain, width, height, occupied, visits }

    let decision
    if (canAttack(me, enemies)) {
      decision = { action: 'stay', reason: 'attack_in_range', target: nearestByDistance(me, enemies) }
    } else if (hpRatio(me) <= number(this.policy.flee_hp_ratio, 0.28) && enemies.length > 0) {
      decision = this._flee(me, enemies, mask, context)
    } else {
      decision = this._pursue(me, enemies, state.powerups, mask, context, frame)
    }

    const teacherAction = mask[actionIndex(decision.action)] ? decision.action : firstValidAction(mask)
    return {
      teacher_action: teacherAction,
      observed_action: frame.inference?.model_action || frame.execution?.executed_action || 'stay',
      executed_action: frame.execution?.executed_action || 'stay',
      sample_weight: this._sampleWeight(frame, result, decision.reason),
      teacher_reason: decision.reason,
      teacher_target: publicTarget(decision.target),
    }
  }

  _pursue(me, enemies, powerups, mask, context, frame) {
    const targets = []
    for (const enemy of enemies) {
      const distance = pathDistanceToAttack(me, enemy, context)
      if (!Number.isFinite(distance) || distance > number(this.policy.max_chase_path, 9)) continue
      const weakness = 1 - hpRatio(enemy)
      const utility = number(this.objective.kills, 0.8) * (1 + weakness) +
        number(this.objective.damage, 0.8) -
        number(this.objective.path_progress, 1) * distance * 0.05
      targets.push({ kind: 'enemy', value: enemy, utility })
    }
    for (const powerup of Array.isArray(powerups) ? powerups : []) {
      if (powerup.active === false || !Number.isInteger(powerup.x) || !Number.isInteger(powerup.y)) continue
      const distance = shortestDistance(me, [powerup], context)
      if (!Number.isFinite(distance)) continue
      targets.push({
        kind: 'powerup',
        value: powerup,
        utility: number(this.objective.powerup, 0.6) * 2 - distance * 0.05,
      })
    }
    targets.sort((left, right) => right.utility - left.utility || targetKey(left).localeCompare(targetKey(right)))

    for (const target of targets) {
      const goals = target.kind === 'enemy'
        ? attackPositions(target.value, me, context)
        : [{ x: target.value.x, y: target.value.y }]
      const ranked = rankMoves(me, goals, mask, context, this.objective)
      if (ranked.length === 0) continue
      const selected = chooseDeterministic(ranked, frame.frame_id, this.profile.profile_hash,
        number(this.policy.teacher_exploration_rate, 0))
      return {
        action: selected.action,
        reason: target.kind === 'enemy' ? 'path_to_enemy' : 'path_to_powerup',
        target: { kind: target.kind, slot: target.value.slot, x: target.value.x, y: target.value.y },
      }
    }

    const fallback = leastVisitedMove(me, mask, context.visits)
    return { action: fallback, reason: fallback === 'stay' ? 'no_reachable_target' : 'explore_unvisited', target: null }
  }

  _flee(me, enemies, mask, context) {
    const ranked = validMoves(me, mask).map(move => {
      const nearest = Math.min(...enemies.map(enemy => manhattan(move, enemy)))
      const visits = context.visits.get(key(move.x, move.y)) || 0
      return { ...move, score: nearest * number(this.objective.survival, 0.8) - visits * number(this.objective.anti_stuck, 1.2) }
    }).sort(compareMoves)
    const selected = ranked[0] || { action: 'stay' }
    return { action: selected.action, reason: 'low_hp_flee', target: nearestByDistance(me, enemies) }
  }

  _sampleWeight(frame, result, reason) {
    let weight = 1
    if (result?.rank === 1) weight += number(this.objective.win, 1)
    else if (result?.rank > 0 && result.rank <= 3) weight += number(this.objective.top3, 0.7) * 0.5
    weight += Math.min(number(result?.kills, 0), 5) * number(this.objective.kills, 0.8) * 0.08
    weight += Math.min(number(result?.damage_dealt, 0) / 500, 1) * number(this.objective.damage, 0.8) * 0.25
    weight += Math.min(number(result?.survived_ticks, 0) / 300, 1) * number(this.objective.survival, 0.8) * 0.25
    if (reason === 'path_to_enemy' || reason === 'path_to_powerup') weight += number(this.objective.path_progress, 1) * 0.15
    if (reason === 'explore_unvisited') weight += number(this.objective.exploration, 0.4) * 0.2
    if (frame.execution?.execution_status === 'blocked_dynamic') weight += number(this.objective.anti_stuck, 1.2) * 0.15
    return Number(Math.max(0.1, Math.min(5, weight)).toFixed(6))
  }
}

function rankMoves(me, goals, mask, context, objective) {
  return validMoves(me, mask).map(move => {
    const distance = shortestDistance(move, goals, context)
    const visits = context.visits.get(key(move.x, move.y)) || 0
    return {
      ...move,
      score: Number.isFinite(distance)
        ? -distance * number(objective.path_progress, 1) - visits * number(objective.anti_stuck, 1.2) +
          number(objective.exploration, 0.4) / (1 + visits)
        : -Infinity,
    }
  }).filter(move => Number.isFinite(move.score)).sort(compareMoves)
}

function shortestDistance(start, goals, context) {
  const goalSet = new Set(goals.map(goal => key(goal.x, goal.y)))
  if (goalSet.has(key(start.x, start.y))) return 0
  const queue = [{ x: start.x, y: start.y, distance: 0 }]
  const seen = new Set([key(start.x, start.y)])
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]
    for (const direction of DIRECTIONS.slice(1)) {
      const next = { x: current.x + direction.dx, y: current.y + direction.dy }
      const nextKey = key(next.x, next.y)
      if (seen.has(nextKey) || !walkable(next.x, next.y, context, goalSet)) continue
      if (goalSet.has(nextKey)) return current.distance + 1
      seen.add(nextKey)
      queue.push({ ...next, distance: current.distance + 1 })
    }
  }
  return Infinity
}

function pathDistanceToAttack(me, enemy, context) {
  return shortestDistance(me, attackPositions(enemy, me, context), context)
}

function attackPositions(enemy, me, context) {
  const goals = []
  for (let y = 0; y < context.height; y++) {
    for (let x = 0; x < context.width; x++) {
      if (!inAttackRange({ ...me, x, y }, enemy)) continue
      if (walkable(x, y, context, new Set([key(x, y)]))) goals.push({ x, y })
    }
  }
  return goals
}

function walkable(x, y, context) {
  if (x < 0 || y < 0 || x >= context.width || y >= context.height) return false
  const terrain = context.terrain[y]?.[x] || 0
  if (terrain === 1 || terrain === 2) return false
  return !context.occupied.has(key(x, y))
}

function validMoves(me, mask) {
  return DIRECTIONS.map((direction, index) => ({
    action: direction.action,
    x: me.x + direction.dx,
    y: me.y + direction.dy,
    index,
  })).filter(move => mask[move.index])
}

function leastVisitedMove(me, mask, visits) {
  const ranked = validMoves(me, mask).map(move => ({
    ...move,
    score: -(visits.get(key(move.x, move.y)) || 0),
  })).sort(compareMoves)
  return ranked[0]?.action || 'stay'
}

function chooseDeterministic(ranked, frameId, profileHash, explorationRate) {
  if (ranked.length < 2 || explorationRate <= 0) return ranked[0]
  const digest = crypto.createHash('sha256').update(`${frameId}:${profileHash || ''}`).digest()
  const random = digest.readUInt32BE(0) / 0xffffffff
  return random < explorationRate ? ranked[1] : ranked[0]
}

function compareMoves(left, right) {
  return right.score - left.score || left.index - right.index
}

function canAttack(me, enemies) {
  return enemies.some(enemy => inAttackRange(me, enemy))
}

function inAttackRange(attacker, target) {
  const range = Math.max(1, Math.floor(number(attacker.range, 1)))
  const dx = Math.abs(attacker.x - target.x)
  const dy = Math.abs(attacker.y - target.y)
  const distance = dx + dy
  const rangeType = attacker.range_type || 'adjacent'
  if (rangeType === 'ranged') return distance >= 2 && distance <= range
  if (rangeType === 'pierce') return distance >= 1 && distance <= range && (dx === 0 || dy === 0)
  return distance >= 1 && distance <= range
}

function nearestByDistance(me, targets) {
  return targets.slice().sort((left, right) => manhattan(me, left) - manhattan(me, right) || left.slot - right.slot)[0] || null
}

function publicTarget(target) {
  if (!target) return null
  return { kind: target.kind || 'enemy', slot: target.slot ?? null, x: target.x, y: target.y }
}

function visitMap(visits) {
  const result = new Map()
  for (const visit of Array.isArray(visits) ? visits : []) {
    if (Number.isInteger(visit.x) && Number.isInteger(visit.y)) result.set(key(visit.x, visit.y), number(visit.count, 0))
  }
  return result
}

function firstValidAction(mask) {
  const index = mask.findIndex(Boolean)
  return DIRECTIONS[index]?.action || 'stay'
}

function actionIndex(action) {
  return DIRECTIONS.findIndex(direction => direction.action === action)
}

function targetKey(target) {
  return `${target.kind}:${target.value.slot ?? ''}:${target.value.x}:${target.value.y}`
}

function hpRatio(agent) {
  return number(agent.hp, 0) / Math.max(number(agent.max_hp, 1), 1)
}

function manhattan(left, right) {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y)
}

function key(x, y) {
  return `${x},${y}`
}

function number(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

module.exports = { GcV8Teacher, DIRECTIONS, shortestDistance }
