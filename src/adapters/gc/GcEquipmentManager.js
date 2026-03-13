const { createLogger } = require('../../utils/logger')
const log = createLogger('gc-equip')

/**
 * GcEquipmentManager — Selects optimal weapon/armor based on historical win rates.
 * Tracks per-loadout performance and adapts over time.
 */
class GcEquipmentManager {
  constructor(store) {
    this.store = store
    this.catalog = { weapons: [], armors: [] }
    this._stats = new Map() // "weapon:armor" → { games, wins, avgRank, totalScore }
    this._minGamesForStats = 5
  }

  setCatalog(equipment) {
    this.catalog.weapons = equipment.weapons || []
    this.catalog.armors = equipment.armors || []
    log.info(`Catalog: ${this.catalog.weapons.length} weapons, ${this.catalog.armors.length} armors`)
  }

  /**
   * Load historical loadout performance from SQLite
   */
  loadStats() {
    if (!this.store) return

    try {
      const sessions = this.store.db.prepare(`
        SELECT result, strategy_log FROM game_sessions
        WHERE game = 'claw-clash' AND result IS NOT NULL
      `).all()

      for (const s of sessions) {
        const result = JSON.parse(s.result || '{}')
        const stratLog = JSON.parse(s.strategy_log || '[]')
        if (!result.rank) continue

        // Extract loadout from first strategy entry or default
        const weapon = result.weapon || 'sword'
        const armor = result.armor || 'leather'
        const key = `${weapon}:${armor}`

        if (!this._stats.has(key)) {
          this._stats.set(key, { games: 0, wins: 0, totalRank: 0, totalScore: 0 })
        }
        const stat = this._stats.get(key)
        stat.games++
        if (result.rank === 1) stat.wins++
        stat.totalRank += result.rank
        stat.totalScore += result.score || 0
      }

      log.info(`Loaded stats for ${this._stats.size} loadout combinations`)
    } catch (err) {
      log.warn('Failed to load loadout stats', err.message)
    }
  }

  /**
   * Record a game result for a specific loadout
   */
  recordResult(weapon, armor, result) {
    const key = `${weapon}:${armor}`
    if (!this._stats.has(key)) {
      this._stats.set(key, { games: 0, wins: 0, totalRank: 0, totalScore: 0 })
    }
    const stat = this._stats.get(key)
    stat.games++
    if (result.rank === 1) stat.wins++
    stat.totalRank += result.rank || 8
    stat.totalScore += result.score || 0
  }

  /**
   * Select the best loadout based on historical performance.
   * Uses UCB1 (Upper Confidence Bound) for exploration vs exploitation.
   */
  selectLoadout() {
    const weapons = this.catalog.weapons.filter(w => w.is_active !== false)
    const armors = this.catalog.armors.filter(a => a.is_active !== false)

    if (weapons.length === 0 || armors.length === 0) {
      return { weapon: 'sword', armor: 'leather', tier: 'basic' }
    }

    const totalGames = Array.from(this._stats.values()).reduce((s, v) => s + v.games, 0)

    let bestScore = -Infinity
    let bestLoadout = null

    for (const w of weapons) {
      const allowedCategories = w.allowed_armors || ['heavy', 'light', 'cloth', 'none']
      const compatibleArmors = armors.filter(a => allowedCategories.includes(a.category))

      for (const a of compatibleArmors) {
        const key = `${w.slug}:${a.slug}`
        const stat = this._stats.get(key)

        let score
        if (!stat || stat.games < this._minGamesForStats) {
          // Unexplored: give high exploration bonus
          score = 10 + Math.random()
        } else {
          // UCB1: avgPerformance + exploration bonus
          const avgRank = stat.totalRank / stat.games
          // Lower rank is better, so invert (9 - avgRank) / 8
          const performance = (9 - avgRank) / 8
          const exploration = Math.sqrt(2 * Math.log(totalGames + 1) / stat.games)
          score = performance + exploration
        }

        if (score > bestScore) {
          bestScore = score
          bestLoadout = { weapon: w.slug, armor: a.slug, tier: 'basic' }
        }
      }
    }

    if (bestLoadout) {
      log.info(`Selected loadout: ${bestLoadout.weapon} + ${bestLoadout.armor} (score: ${bestScore.toFixed(3)})`)
      return bestLoadout
    }

    return { weapon: 'sword', armor: 'leather', tier: 'basic' }
  }

  /**
   * Get performance summary for all loadouts
   */
  getSummary() {
    const summary = []
    for (const [key, stat] of this._stats) {
      if (stat.games === 0) continue
      summary.push({
        loadout: key,
        games: stat.games,
        winRate: (stat.wins / stat.games * 100).toFixed(1) + '%',
        avgRank: (stat.totalRank / stat.games).toFixed(2),
        avgScore: (stat.totalScore / stat.games).toFixed(0),
      })
    }
    return summary.sort((a, b) => parseFloat(a.avgRank) - parseFloat(b.avgRank))
  }
}

module.exports = GcEquipmentManager
