const fs = require('fs')
const path = require('path')
const { createLogger } = require('../../utils/logger')
const log = createLogger('exporter')

class TrainingExporter {
  constructor(store, exportDir) {
    this.store = store
    this.exportDir = exportDir || './training/data/raw'
  }

  exportForTraining(game, minSessions = 10) {
    const sessions = this.store.db.prepare(`
      SELECT * FROM game_sessions WHERE game = ? AND result IS NOT NULL AND result != 'null' ORDER BY id
    `).all(game)

    if (sessions.length < minSessions) {
      log.info(`Not enough sessions (${sessions.length}/${minSessions}), skipping export`)
      return null
    }

    fs.mkdirSync(this.exportDir, { recursive: true })

    // Export sessions
    const sessionsPath = path.join(this.exportDir, `${game}_sessions.json`)
    const sessionData = sessions.map(s => ({
      id: s.id,
      game_id: s.game_id,
      my_slot: s.my_slot,
      result: JSON.parse(s.result || 'null'),
      strategy_log: JSON.parse(s.strategy_log || '[]'),
      started_at: s.started_at,
      ended_at: s.ended_at,
    }))
    fs.writeFileSync(sessionsPath, JSON.stringify(sessionData, null, 2))
    log.info(`Exported ${sessions.length} sessions → ${sessionsPath}`)

    // Export tick data with features
    const ticksPath = path.join(this.exportDir, `${game}_ticks.csv`)
    const tickStmt = this.store.db.prepare(`
      SELECT bt.*, gs.result as game_result, gs.my_slot
      FROM battle_ticks bt
      JOIN game_sessions gs ON gs.id = bt.session_id
      WHERE gs.game = ? AND bt.my_features IS NOT NULL AND gs.result IS NOT NULL AND gs.result != 'null'
      ORDER BY bt.session_id, bt.tick, bt.sub_tick
    `)

    const ticks = tickStmt.all(game)
    if (ticks.length === 0) {
      log.info('No tick data with features to export')
      return sessionsPath
    }

    // CSV header: session_id, tick, sub_tick, f0, f1, ..., f161, action, rank, score
    const firstFeatures = JSON.parse(ticks[0].my_features)
    const featureCount = firstFeatures.length
    const header = ['session_id', 'tick', 'sub_tick']
    for (let i = 0; i < featureCount; i++) header.push(`f${i}`)
    header.push('action', 'rank', 'score')

    const lines = [header.join(',')]
    for (const t of ticks) {
      const features = JSON.parse(t.my_features)
      const result = JSON.parse(t.game_result || '{}') || {}
      const decision = JSON.parse(t.my_decision || 'null')
      const action = decision ? (decision.action || 'stay') : 'stay'
      const row = [t.session_id, t.tick, t.sub_tick]
      row.push(...features)
      row.push(action, result.rank || 0, result.score || 0)
      lines.push(row.join(','))
    }

    fs.writeFileSync(ticksPath, lines.join('\n'))
    log.info(`Exported ${ticks.length} tick features → ${ticksPath}`)

    return { sessionsPath, ticksPath, sessionCount: sessions.length, tickCount: ticks.length }
  }
}

module.exports = TrainingExporter
