const { createLogger } = require('../../utils/logger')
const log = createLogger('gc-strategy')

class GcStrategyEngine {
  constructor() {
    this.lastStrategy = null
    this.changesCount = 0
    this.maxChanges = 30
  }

  reset() {
    this.lastStrategy = null
    this.changesCount = 0
  }

  decide(gameState) {
    if (this.changesCount >= this.maxChanges) return null

    const me = gameState.me
    if (!me || !me.alive) return null

    const enemies = gameState.agents.filter(a => a.alive && a.slot !== me.slot)
    if (enemies.length === 0) return null

    const hpRatio = me.hp / me.maxHp
    const livingCount = enemies.length + 1
    const shrinkPhase = gameState.shrinkPhase || 0

    let strategy

    // 1v1 endgame — all-in aggressive
    if (enemies.length === 1) {
      strategy = {
        mode: 'aggressive',
        target_priority: 'lowest_hp',
        flee_threshold: 5,
      }
    }
    // Critical HP — flee
    else if (hpRatio < 0.2) {
      strategy = {
        mode: 'defensive',
        target_priority: 'nearest',
        flee_threshold: 30,
      }
    }
    // Low HP but ring closing — must fight
    else if (hpRatio < 0.35 && shrinkPhase >= 2) {
      strategy = {
        mode: 'balanced',
        target_priority: 'lowest_hp',
        flee_threshold: 15,
      }
    }
    // Healthy, many enemies — pick off weak targets
    else if (hpRatio > 0.6 && livingCount >= 5) {
      strategy = {
        mode: 'balanced',
        target_priority: 'lowest_hp',
        flee_threshold: 15,
      }
    }
    // Healthy, few enemies — aggressive
    else if (hpRatio > 0.5 && livingCount <= 3) {
      strategy = {
        mode: 'aggressive',
        target_priority: 'lowest_hp',
        flee_threshold: 10,
      }
    }
    // Ring closing — push in
    else if (shrinkPhase >= 1) {
      strategy = {
        mode: 'aggressive',
        target_priority: 'nearest',
        flee_threshold: 15,
      }
    }
    // Default — balanced
    else {
      strategy = {
        mode: 'balanced',
        target_priority: 'nearest',
        flee_threshold: 15,
      }
    }

    // Skip if same as last
    if (this.lastStrategy &&
        this.lastStrategy.mode === strategy.mode &&
        this.lastStrategy.target_priority === strategy.target_priority &&
        this.lastStrategy.flee_threshold === strategy.flee_threshold) {
      return null
    }

    this.lastStrategy = strategy
    this.changesCount++
    log.debug(`Strategy #${this.changesCount}: ${strategy.mode} / ${strategy.target_priority} / flee@${strategy.flee_threshold}`)
    return strategy
  }
}

module.exports = GcStrategyEngine
