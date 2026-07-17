const { STRATEGY_LABELS } = require('../config/gcStrategyV81Contract')

class GcStrategyV81Teacher {
  constructor(profile) {
    this.profile = profile || {}
    this.objective = this.profile.objective || {}
    this.policy = this.profile.policy || {}
  }

  buildSample(frame, session, result = null) {
    if (frame?.contract?.feature_version !== '8.1' || frame?.record_version !== 2) {
      throw new Error('strategy teacher requires a v8.1 record_version=2 frame')
    }
    const features = frame.input?.feature_vector
    const mask = frame.input?.strategy_mask?.map(value => value ? 1 : 0)
    if (!Array.isArray(features) || features.length !== 214) throw new Error('strategy teacher requires 214 features')
    if (!Array.isArray(mask) || mask.length !== 11) throw new Error('strategy teacher requires an 11-value mask')

    const candidates = candidateMap(session)
    const scored = []
    for (let candidate = 0; candidate < 7; candidate++) {
      const labelIndex = 4 + candidate
      if (!mask[labelIndex]) continue
      const base = 26 + candidate * 16
      const hpRatio = features[base + 1]
      const pathRatio = features[base + 5]
      const damageRatio = features[base + 7]
      const defenseRatio = features[base + 9]
      const readiness = features[base + 11]
      const canHitSelf = features[base + 12]
      const selfCanHit = features[base + 13]
      const expectedDamage = Math.max(0.05, features[3] - defenseRatio)
      const finish = Math.max(0, 1 - hpRatio)
      const killProbability = Math.min(1, expectedDamage / Math.max(0.05, hpRatio))
      const threat = damageRatio * (0.5 + readiness * 0.5)
      const retaliation = canHitSelf * threat
      // Navigator still takes an immediate safe finish instead of exploring forever.
      const immediateFinish = this.profile.profile_id === 'navigator'
        ? selfCanHit * (killProbability * 1.25 + finish * 0.5)
        : 0
      const utility = value(this.objective.kills, 0.8) * (killProbability + finish) +
        value(this.objective.damage, 0.8) * (expectedDamage + selfCanHit * 0.25) +
        immediateFinish +
        value(this.objective.win, 1) * threat * 0.15 -
        value(this.objective.survival, 0.8) * retaliation -
        value(this.objective.path_progress, 1) * pathRatio
      scored.push({ candidate, labelIndex, utility, targetSlot: candidates.get(candidate) ?? null })
    }
    scored.sort((left, right) => right.utility - left.utility || left.candidate - right.candidate)

    const selfHp = features[0]
    const threatRatio = features[208]
    const noProgress = features[189]
    const loopPressure = Math.max(features[191], features[192])
    const options = [{ labelIndex: 0, utility: 0, reason: 'hold' }]
    if (mask[1]) {
      const belowThreshold = Math.max(0, value(this.policy.flee_hp_ratio, 0.28) - selfHp)
      options.push({
        labelIndex: 1,
        utility: value(this.objective.survival, 0.8) * (belowThreshold * 4 + threatRatio + features[212]) -
          value(this.objective.kills, 0.8) * features[210] * 0.25,
        reason: belowThreshold > 0 ? 'profile_flee_hp' : 'profile_flee_risk',
      })
    }
    if (mask[2]) {
      options.push({ labelIndex: 2, utility: value(this.objective.powerup, 0.6) * (1 - features[140]), reason: 'profile_powerup' })
    }
    if (mask[3]) {
      options.push({
        labelIndex: 3,
        utility: value(this.objective.exploration, 0.4) * features[213] +
          value(this.objective.anti_stuck, 1.2) * (noProgress + loopPressure) -
          value(this.objective.kills, 0.8) * features[210] * 0.2 -
          (value(this.objective.kills, 0.8) + value(this.objective.damage, 0.8)) * features[207] * 0.5,
        reason: loopPressure > 0 ? 'profile_break_loop' : 'profile_explore',
      })
    }
    if (scored[0]) options.push({ ...scored[0], reason: 'profile_attack_target' })
    options.sort((left, right) => right.utility - left.utility || left.labelIndex - right.labelIndex)
    const selected = options.find(option => mask[option.labelIndex]) || { labelIndex: 0, reason: 'mask_fallback' }
    const teacherStrategy = STRATEGY_LABELS[selected.labelIndex]

    return {
      teacher_strategy: teacherStrategy,
      teacher_target_slot: selected.targetSlot ?? null,
      teacher_reason: selected.reason,
      observed_strategy: frame.inference?.model_strategy || frame.execution?.executed_strategy || 'hold',
      executed_strategy: frame.execution?.executed_strategy || 'hold',
      sample_weight: sampleWeight(this.objective, frame, result),
    }
  }
}

function candidateMap(session) {
  const entries = session?.manifest?.strategy_candidates || session?.strategy_candidates || []
  return new Map(entries.map(entry => [entry.candidate, entry.slot]))
}

function sampleWeight(objective, frame, result) {
  let weight = 1
  if (result?.rank === 1) weight += value(objective.win, 1)
  else if (result?.rank > 0 && result.rank <= 3) weight += value(objective.top3, 0.7) * 0.5
  weight += Math.min(value(result?.kills, 0), 5) * value(objective.kills, 0.8) * 0.08
  weight += Math.min(value(result?.damage_dealt, 0) / 500, 1) * value(objective.damage, 0.8) * 0.25
  weight += Math.min(value(result?.survived_ticks, 0) / 300, 1) * value(objective.survival, 0.8) * 0.25
  if (frame.execution?.strategy_override_reason) weight *= 0.75
  return Number(Math.max(0.1, Math.min(5, weight)).toFixed(6))
}

function value(input, fallback) {
  return typeof input === 'number' && Number.isFinite(input) ? input : fallback
}

module.exports = { GcStrategyV81Teacher }
