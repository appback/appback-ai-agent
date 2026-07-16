const ACTIONS = Object.freeze([
  { action: 'stay', dx: 0, dy: 0 },
  { action: 'up', dx: 0, dy: -1 },
  { action: 'down', dx: 0, dy: 1 },
  { action: 'left', dx: -1, dy: 0 },
  { action: 'right', dx: 1, dy: 0 },
])

const DEFAULT_THRESHOLDS = Object.freeze({
  goal_reach_rate_min: 0.95,
  path_efficiency_max: 1.25,
  loop_rate_max: 0.02,
  invalid_action_rate_max: 0,
})

class GcMazeEvaluator {
  constructor(options = {}) {
    if (typeof options.decide !== 'function') throw new Error('Maze evaluator requires a decide function')
    this.decide = options.decide
    this.profile = options.profile || {}
    this.scenarioCount = positiveInteger(options.scenarioCount, 200)
    this.seed = uint32(options.seed, 20260716)
    this.width = oddSize(options.width, 15)
    this.height = oddSize(options.height, 15)
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) }
  }

  evaluate() {
    const scenarios = []
    for (let index = 0; index < this.scenarioCount; index++) {
      scenarios.push(this._runScenario(index, mixSeed(this.seed, index)))
    }

    const reached = scenarios.filter(item => item.reached)
    const totalActions = scenarios.reduce((sum, item) => sum + item.actions, 0)
    const invalidActions = scenarios.reduce((sum, item) => sum + item.invalid_actions, 0)
    const metrics = {
      goal_reach_rate: ratio(reached.length, scenarios.length),
      path_efficiency: average(reached.map(item => item.path_efficiency)),
      loop_rate: ratio(scenarios.filter(item => item.loop_detected).length, scenarios.length),
      invalid_action_rate: ratio(invalidActions, totalActions),
      no_progress_rate: ratio(scenarios.filter(item => item.no_progress_detected).length, scenarios.length),
      average_actions: average(scenarios.map(item => item.actions)),
      average_optimal_actions: average(scenarios.map(item => item.optimal_actions)),
    }
    const gates = {
      goal_reach_rate: metrics.goal_reach_rate >= this.thresholds.goal_reach_rate_min,
      path_efficiency: metrics.path_efficiency <= this.thresholds.path_efficiency_max,
      loop_rate: metrics.loop_rate <= this.thresholds.loop_rate_max,
      invalid_action_rate: metrics.invalid_action_rate <= this.thresholds.invalid_action_rate_max,
    }

    return {
      schema_version: 1,
      evaluator_version: 'gc-maze-v1',
      policy: 'bfs_teacher',
      profile: {
        id: this.profile.profile_id || 'unknown',
        hash: this.profile.profile_hash || 'unknown',
      },
      configuration: {
        scenario_count: this.scenarioCount,
        seed: this.seed,
        width: this.width,
        height: this.height,
      },
      thresholds: this.thresholds,
      metrics,
      gates,
      passed: Object.values(gates).every(Boolean),
      failed_scenarios: scenarios.filter(item => !item.reached || item.loop_detected || item.invalid_actions > 0),
    }
  }

  _runScenario(index, seed) {
    const scenario = generateMazeScenario(seed, this.width, this.height)
    const me = {
      slot: 0,
      x: scenario.start.x,
      y: scenario.start.y,
      hp: 100,
      max_hp: 100,
      alive: true,
      range: 1,
      range_type: 'adjacent',
    }
    const target = { ...scenario.target, active: true, kind: 'powerup' }
    const optimal = distanceToCell(me, target, scenario.terrain)
    const maxTicks = Math.max(20, optimal * 3 + 5)
    const visits = new Map([[positionKey(me), 1]])
    const positions = [positionKey(me)]
    let actions = 0
    let invalidActions = 0
    let loopDetected = false
    let noProgressStreak = 0
    let noProgressDetected = false
    let previousDistance = optimal

    for (let tick = 0; tick < maxTicks && !atTarget(me, target); tick++) {
      const mask = actionMask(me, scenario.terrain)
      const frame = evaluationFrame(index, tick, me, target, mask, visits, this.profile)
      const session = evaluationSession(index, scenario.terrain)
      const decision = this.decide(frame, session)
      const action = typeof decision === 'string' ? decision : decision?.teacher_action
      const actionIndex = ACTIONS.findIndex(item => item.action === action)
      actions++

      if (actionIndex < 0 || !mask[actionIndex]) {
        invalidActions++
      } else {
        me.x += ACTIONS[actionIndex].dx
        me.y += ACTIONS[actionIndex].dy
      }

      const currentKey = positionKey(me)
      visits.set(currentKey, (visits.get(currentKey) || 0) + 1)
      positions.push(currentKey)
      loopDetected ||= hasTwoCycle(positions) || hasThreeCycle(positions)

      const currentDistance = distanceToCell(me, target, scenario.terrain)
      if (currentDistance < previousDistance) noProgressStreak = 0
      else noProgressStreak++
      if (noProgressStreak >= 3) noProgressDetected = true
      previousDistance = currentDistance
    }

    const reached = atTarget(me, target)
    return {
      index,
      seed,
      reached,
      actions,
      optimal_actions: optimal,
      path_efficiency: reached && optimal > 0 ? round(actions / optimal) : null,
      loop_detected: loopDetected,
      invalid_actions: invalidActions,
      no_progress_detected: noProgressDetected,
      final_position: { x: me.x, y: me.y },
      target: scenario.target,
    }
  }
}

function generateMazeScenario(seed, width, height) {
  const random = mulberry32(seed)
  const terrain = Array.from({ length: height }, () => new Array(width).fill(1))
  const stack = [{ x: 1, y: 1 }]
  terrain[1][1] = 0
  while (stack.length > 0) {
    const current = stack[stack.length - 1]
    const candidates = [
      { x: current.x, y: current.y - 2 },
      { x: current.x, y: current.y + 2 },
      { x: current.x - 2, y: current.y },
      { x: current.x + 2, y: current.y },
    ].filter(next => next.x > 0 && next.y > 0 && next.x < width - 1 && next.y < height - 1 && terrain[next.y][next.x] === 1)
    if (candidates.length === 0) {
      stack.pop()
      continue
    }
    const next = candidates[Math.floor(random() * candidates.length)]
    terrain[(current.y + next.y) / 2][(current.x + next.x) / 2] = 0
    terrain[next.y][next.x] = 0
    stack.push(next)
  }
  const start = { x: 1, y: 1 }
  const target = farthestCell(start, terrain)
  return { terrain, start, target }
}

function farthestCell(start, terrain) {
  const queue = [{ ...start, distance: 0 }]
  const seen = new Set([positionKey(start)])
  let farthest = queue[0]
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]
    if (current.distance > farthest.distance) farthest = current
    for (const direction of ACTIONS.slice(1)) {
      const next = { x: current.x + direction.dx, y: current.y + direction.dy }
      const key = positionKey(next)
      if (seen.has(key) || !isWalkable(next.x, next.y, terrain)) continue
      seen.add(key)
      queue.push({ ...next, distance: current.distance + 1 })
    }
  }
  return { x: farthest.x, y: farthest.y }
}

function distanceToCell(start, target, terrain) {
  if (atTarget(start, target)) return 0
  const queue = [{ x: start.x, y: start.y, distance: 0 }]
  const seen = new Set([positionKey(start)])
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]
    for (const direction of ACTIONS.slice(1)) {
      const next = { x: current.x + direction.dx, y: current.y + direction.dy }
      const key = positionKey(next)
      if (seen.has(key) || !isWalkable(next.x, next.y, terrain)) continue
      if (atTarget(next, target)) return current.distance + 1
      seen.add(key)
      queue.push({ ...next, distance: current.distance + 1 })
    }
  }
  return Infinity
}

function actionMask(me, terrain) {
  return ACTIONS.map((direction, index) => {
    if (index === 0) return 1
    const x = me.x + direction.dx
    const y = me.y + direction.dy
    return isWalkable(x, y, terrain) ? 1 : 0
  })
}

function evaluationFrame(scenarioIndex, tick, me, target, mask, visits, profile) {
  return {
    frame_id: `maze-${scenarioIndex}-${tick}`,
    tick,
    agent: { slot: me.slot },
    behavior_profile: { id: profile.profile_id, hash: profile.profile_hash },
    input: { action_mask: mask },
    inference: { model_action: 'stay' },
    execution: { executed_action: 'stay', execution_status: 'applied', override_reason: null },
    history_before: {
      visits: Array.from(visits, ([key, count]) => {
        const [x, y] = key.split(',').map(Number)
        return { x, y, count }
      }),
    },
    state: { agents: [{ ...me }], powerups: [{ ...target }] },
  }
}

function evaluationSession(index, terrain) {
  return {
    session_id: `maze-session-${index}`,
    manifest: { arena: { width: terrain[0].length, height: terrain.length, terrain } },
  }
}

function atTarget(position, target) {
  return position.x === target.x && position.y === target.y
}

function isWalkable(x, y, terrain) {
  return y >= 0 && y < terrain.length && x >= 0 && x < terrain[0].length && terrain[y][x] === 0
}

function hasTwoCycle(positions) {
  const n = positions.length
  return n >= 4 && positions[n - 1] === positions[n - 3] && positions[n - 2] === positions[n - 4]
}

function hasThreeCycle(positions) {
  const n = positions.length
  return n >= 6 && positions[n - 1] === positions[n - 4] &&
    positions[n - 2] === positions[n - 5] && positions[n - 3] === positions[n - 6]
}

function positionKey(position) {
  return `${position.x},${position.y}`
}

function mixSeed(seed, index) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x85ebca6b) >>> 0
  value ^= value >>> 13
  return value >>> 0
}

function mulberry32(seed) {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let result = value
    result = Math.imul(result ^ (result >>> 15), result | 1)
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61)
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : 0
}

function average(values) {
  const finiteValues = values.filter(Number.isFinite)
  return finiteValues.length ? round(finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length) : 0
}

function round(value) {
  return Number(value.toFixed(6))
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function oddSize(value, fallback) {
  const number = positiveInteger(value, fallback)
  return number >= 5 && number % 2 === 1 ? number : fallback
}

function uint32(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number <= 0xffffffff ? number : fallback
}

module.exports = { GcMazeEvaluator, DEFAULT_THRESHOLDS, generateMazeScenario, distanceToCell }
