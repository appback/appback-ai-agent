const { createLogger } = require('./logger')
const log = createLogger('metrics')

/**
 * Metrics — Tracks agent performance across games.
 */
class Metrics {
  constructor(store) {
    this.store = store
    this._current = {
      gamesPlayed: 0,
      wins: 0,
      podiums: 0, // top 3
      totalScore: 0,
      totalRank: 0,
      kills: 0,
      modelVersion: 'rule-based',
    }
  }

  load(game) {
    if (!this.store) return

    try {
      const sessions = this.store.db.prepare(`
        SELECT result FROM game_sessions
        WHERE game = ? AND result IS NOT NULL
      `).all(game)

      for (const s of sessions) {
        const r = JSON.parse(s.result || '{}')
        this._record(r)
      }

      log.info(`Loaded metrics: ${this._current.gamesPlayed} games, ` +
        `win rate ${this.winRate}%, avg rank ${this.avgRank}`)
    } catch (err) {
      log.warn('Failed to load metrics', err.message)
    }
  }

  record(result) {
    this._record(result)
    this._logSummary()
  }

  _record(result) {
    if (!result) return
    this._current.gamesPlayed++
    if (result.rank === 1) this._current.wins++
    if (result.rank <= 3) this._current.podiums++
    this._current.totalScore += result.score || 0
    this._current.totalRank += result.rank || 8
    this._current.kills += result.kills || 0
  }

  get gamesPlayed() { return this._current.gamesPlayed }
  get winRate() {
    if (this._current.gamesPlayed === 0) return '0.0'
    return (this._current.wins / this._current.gamesPlayed * 100).toFixed(1)
  }
  get podiumRate() {
    if (this._current.gamesPlayed === 0) return '0.0'
    return (this._current.podiums / this._current.gamesPlayed * 100).toFixed(1)
  }
  get avgRank() {
    if (this._current.gamesPlayed === 0) return '0.0'
    return (this._current.totalRank / this._current.gamesPlayed).toFixed(2)
  }
  get avgScore() {
    if (this._current.gamesPlayed === 0) return '0'
    return (this._current.totalScore / this._current.gamesPlayed).toFixed(0)
  }
  get totalKills() { return this._current.kills }

  _logSummary() {
    log.info(
      `[${this._current.gamesPlayed} games] ` +
      `win: ${this.winRate}% | top3: ${this.podiumRate}% | ` +
      `avgRank: ${this.avgRank} | avgScore: ${this.avgScore} | kills: ${this.totalKills}`
    )
  }

  toJSON() {
    return {
      gamesPlayed: this.gamesPlayed,
      winRate: this.winRate + '%',
      podiumRate: this.podiumRate + '%',
      avgRank: this.avgRank,
      avgScore: this.avgScore,
      totalKills: this.totalKills,
    }
  }
}

module.exports = Metrics
