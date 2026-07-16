const { compileProfile } = require('../config/ProfileCompiler')
const { createEasyProfile } = require('../config/BehaviorProfileStore')
const { PRESETS } = require('../config/personalityPresets')
const { GcV8Teacher } = require('../training/GcV8Teacher')

class GcPersonalityEvaluator {
  constructor(options = {}) {
    this.presets = options.presets || Object.keys(PRESETS)
    this.scenarios = options.scenarios || canonicalScenarios()
  }

  evaluate() {
    const profiles = Object.fromEntries(this.presets.map(id => [
      id,
      compileProfile(createEasyProfile(id, 0, 1)),
    ]))
    const decisions = {}
    for (const [id, profile] of Object.entries(profiles)) {
      const teacher = new GcV8Teacher(profile)
      decisions[id] = this.scenarios.map(scenario => {
        const sample = teacher.buildSample(clone(scenario.frame), clone(scenario.session))
        return {
          scenario: scenario.id,
          action: sample.teacher_action,
          reason: sample.teacher_reason,
          target_kind: sample.teacher_target?.kind || null,
        }
      })
    }

    const signatures = Object.fromEntries(Object.entries(decisions).map(([id, values]) => [
      id,
      values.map(value => `${value.action}:${value.reason}:${value.target_kind || '-'}`).join('|'),
    ]))
    const pairwise = []
    const ids = Object.keys(decisions)
    for (let left = 0; left < ids.length; left++) {
      for (let right = left + 1; right < ids.length; right++) {
        const leftId = ids[left]
        const rightId = ids[right]
        let actionDifferences = 0
        let decisionDifferences = 0
        for (let index = 0; index < this.scenarios.length; index++) {
          const a = decisions[leftId][index]
          const b = decisions[rightId][index]
          if (a.action !== b.action) actionDifferences++
          if (a.action !== b.action || a.reason !== b.reason || a.target_kind !== b.target_kind) decisionDifferences++
        }
        pairwise.push({
          profiles: [leftId, rightId],
          action_difference_rate: ratio(actionDifferences, this.scenarios.length),
          decision_difference_rate: ratio(decisionDifferences, this.scenarios.length),
        })
      }
    }

    const lowHp = scenarioDecisionMap(decisions, 'low_hp_enemy')
    const resource = scenarioDecisionMap(decisions, 'enemy_or_powerup')
    const gates = {
      hunter_pursues_when_survivor_flees:
        lowHp.hunter?.reason === 'path_to_enemy' && lowHp.survivor?.reason === 'low_hp_flee' &&
        lowHp.hunter?.action !== lowHp.survivor?.action,
      collector_prefers_powerup_over_hunter:
        resource.hunter?.target_kind === 'enemy' && resource.collector?.target_kind === 'powerup' &&
        resource.hunter?.action !== resource.collector?.action,
      at_least_three_unique_signatures: new Set(Object.values(signatures)).size >= 3,
    }

    return {
      schema_version: 1,
      evaluator_version: 'gc-personality-v1',
      configuration: { variation_percent: 0, seed: 1, scenario_count: this.scenarios.length },
      scenarios: this.scenarios.map(item => item.id),
      profiles: Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, {
        hash: profile.profile_hash,
        decisions: decisions[id],
        signature: signatures[id],
      }])),
      pairwise,
      metrics: { unique_signature_count: new Set(Object.values(signatures)).size },
      gates,
      passed: Object.values(gates).every(Boolean),
    }
  }
}

function canonicalScenarios() {
  const terrain = Array.from({ length: 7 }, () => new Array(7).fill(0))
  const session = { manifest: { arena: { width: 7, height: 7, terrain } } }
  return [
    scenario('low_hp_enemy', session, {
      me: agent(0, 3, 3, 20),
      agents: [agent(1, 5, 3, 100)],
      powerups: [],
      visits: [{ x: 3, y: 2, count: 1 }, { x: 3, y: 4, count: 1 }],
    }),
    scenario('enemy_or_powerup', session, {
      me: agent(0, 3, 3, 100),
      agents: [agent(1, 5, 3, 10)],
      powerups: [{ kind: 'powerup', x: 3, y: 1, active: true }],
      visits: [],
    }),
    scenario('healthy_enemy', session, {
      me: agent(0, 1, 1, 100),
      agents: [agent(1, 5, 1, 70)],
      powerups: [],
      visits: [],
    }),
    scenario('visited_fork', session, {
      me: agent(0, 3, 3, 100),
      agents: [agent(1, 5, 5, 100)],
      powerups: [],
      visits: [{ x: 3, y: 4, count: 3 }],
    }),
  ]
}

function scenario(id, session, input) {
  return {
    id,
    session,
    frame: {
      frame_id: `personality-${id}`,
      agent: { slot: 0 },
      input: { action_mask: [1, 1, 1, 1, 1] },
      inference: { model_action: 'stay' },
      execution: { executed_action: 'stay', execution_status: 'applied', override_reason: null },
      history_before: { visits: input.visits },
      state: { agents: [input.me, ...input.agents], powerups: input.powerups },
    },
  }
}

function agent(slot, x, y, hp) {
  return { slot, x, y, hp, max_hp: 100, alive: true, range: 1, range_type: 'adjacent' }
}

function scenarioDecisionMap(decisions, scenarioId) {
  return Object.fromEntries(Object.entries(decisions).map(([id, values]) => [
    id,
    values.find(value => value.scenario === scenarioId),
  ]))
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : 0
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

module.exports = { GcPersonalityEvaluator, canonicalScenarios }
