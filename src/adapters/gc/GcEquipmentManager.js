const { createLogger } = require('../../utils/logger')
const log = createLogger('gc-equip')

const DEFAULT_PREFERENCES = Object.freeze({
  damage: 1,
  range: 1,
  speed: 1,
  defense: 1,
  evasion: 1,
  skill: 1,
  history: 1,
  exploration: 0.7,
})

/**
 * Selects a compatible loadout from personality preferences and historical rank.
 * Performance remains scoped by the store's operation/profile context.
 */
class GcEquipmentManager {
  constructor(store, behaviorProfile = null) {
    this.store = store
    this.preferences = {
      ...DEFAULT_PREFERENCES,
      ...(behaviorProfile?.equipment || {}),
    }
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
      let results = this.store.getLoadoutResults?.() || []
      if (results.length === 0) results = this._legacyLoadoutResults()
      for (const result of results) this.recordResult(result.weapon, result.armor, result)

      log.info(`Loaded stats for ${this._stats.size} loadout combinations`)
    } catch (err) {
      log.warn('Failed to load loadout stats', err.message)
    }
  }

  _legacyLoadoutResults() {
    if (!this.store.getCompletedSessionResults) return []
    return this.store.getCompletedSessionResults('claw-clash')
      .map(session => JSON.parse(session.result || '{}'))
      .filter(result => result.rank && result.weapon && result.armor)
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
   * Select by personality preference plus profile-scoped historical UCB performance.
   */
  selectLoadout() {
    const weapons = this.catalog.weapons.filter(w => w.is_active !== false)
    const armors = this.catalog.armors.filter(a => a.is_active !== false)

    if (weapons.length === 0 || armors.length === 0) {
      return { weapon: 'sword', armor: 'leather', tier: 'basic' }
    }

    const combinations = []
    for (const weapon of weapons) {
      const allowedCategories = weapon.allowed_armors || ['heavy', 'light', 'cloth', 'none']
      for (const armor of armors.filter(item => allowedCategories.includes(item.category))) {
        combinations.push({
          weapon,
          armor,
          key: `${weapon.slug}:${armor.slug}`,
          metrics: rawEquipmentMetrics(weapon, armor),
        })
      }
    }
    combinations.sort((left, right) => left.key.localeCompare(right.key))
    if (combinations.length === 0) return { weapon: 'sword', armor: 'leather', tier: 'basic' }

    const ranges = metricRanges(combinations)
    const totalGames = Array.from(this._stats.values()).reduce((sum, value) => sum + value.games, 0)

    let bestScore = -Infinity
    let bestLoadout = null
    let bestDetails = null

    for (const combination of combinations) {
      const normalized = normalizeMetrics(combination.metrics, ranges)
      const preference = weightedPreference(normalized, this.preferences)
      const stat = this._stats.get(combination.key)
      const games = stat?.games || 0
      const performance = stat && stat.games > 0
        ? clamp((9 - (stat.totalRank / stat.games)) / 8, 0, 1)
        : 0.5
      const confidence = Math.min(games / this._minGamesForStats, 1)
      const history = performance * confidence + 0.5 * (1 - confidence)
      const exploration = normalizedUcbExploration(totalGames, games)
      const score = preference + this.preferences.history * history +
        this.preferences.exploration * exploration

      if (score > bestScore) {
        bestScore = score
        bestLoadout = {
          weapon: combination.weapon.slug,
          armor: combination.armor.slug,
          tier: 'basic',
        }
        bestDetails = { preference, history, exploration, games }
      }
    }

    if (bestLoadout) {
      log.info(
        `Selected loadout: ${bestLoadout.weapon} + ${bestLoadout.armor} ` +
        `(score=${bestScore.toFixed(3)}, preference=${bestDetails.preference.toFixed(3)}, ` +
        `history=${bestDetails.history.toFixed(3)}, exploration=${bestDetails.exploration.toFixed(3)}, ` +
        `games=${bestDetails.games})`
      )
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

function rawEquipmentMetrics(weapon, armor) {
  const damageMin = finite(weapon.damage_min, weapon.damage, 0)
  const damageMax = finite(weapon.damage_max, weapon.damage, damageMin)
  return {
    damage: (damageMin + damageMax) / 2,
    range: finite(weapon.range, 0),
    speed: finite(weapon.speed, 100) + finite(armor.speed_mod, 0),
    defense: finite(armor.dmg_reduction, 0),
    evasion: finite(armor.evasion, 0),
    skill: skillPotential(weapon, (damageMin + damageMax) / 2),
  }
}

function skillPotential(weapon, averageDamage) {
  const skill = weapon.skill
  if (!skill || typeof skill !== 'object') return 0
  const chance = clamp(finite(skill.chance, 0.1), 0, 1)
  let impact = finite(skill.value, 0)
  if (skill.effect === 'triple_strike') impact = averageDamage * 2
  if (impact <= 0) impact = averageDamage
  return chance * impact
}

function metricRanges(combinations) {
  const ranges = {}
  for (const key of ['damage', 'range', 'speed', 'defense', 'evasion', 'skill']) {
    const values = combinations.map(item => item.metrics[key])
    ranges[key] = { min: Math.min(...values), max: Math.max(...values) }
  }
  return ranges
}

function normalizeMetrics(metrics, ranges) {
  const normalized = {}
  for (const [key, value] of Object.entries(metrics)) {
    const range = ranges[key]
    normalized[key] = range.max === range.min ? (value > 0 ? 1 : 0) :
      (value - range.min) / (range.max - range.min)
  }
  return normalized
}

function weightedPreference(metrics, preferences) {
  const keys = ['damage', 'range', 'speed', 'defense', 'evasion', 'skill']
  const weight = keys.reduce((sum, key) => sum + preferences[key], 0)
  if (weight <= 0) return 0
  return keys.reduce((sum, key) => sum + metrics[key] * preferences[key], 0) / weight
}

function normalizedUcbExploration(totalGames, games) {
  const numerator = 2 * Math.log(totalGames + 2)
  const maximum = Math.sqrt(numerator)
  if (maximum === 0) return 0
  return Math.sqrt(numerator / (games + 1)) / maximum
}

function finite(...values) {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

module.exports = GcEquipmentManager
