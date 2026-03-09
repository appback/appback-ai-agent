const Database = require('better-sqlite3')
const path = require('path')
const { createLogger } = require('../../utils/logger')
const log = createLogger('sqlite')

class SqliteStore {
  constructor(dataDir) {
    const dbPath = path.join(dataDir || './data', 'agent.db')
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this._initSchema()
    log.info(`SQLite database: ${dbPath}`)
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_identity (
        game TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        api_token TEXT NOT NULL,
        name TEXT,
        registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS game_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game TEXT NOT NULL,
        game_id TEXT NOT NULL,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        my_slot INTEGER,
        result TEXT,
        model_version TEXT,
        strategy_log TEXT
      );

      CREATE TABLE IF NOT EXISTS battle_ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER REFERENCES game_sessions(id),
        tick INTEGER NOT NULL,
        sub_tick INTEGER NOT NULL,
        state TEXT NOT NULL,
        my_features TEXT,
        my_decision TEXT
      );

      CREATE TABLE IF NOT EXISTS training_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_type TEXT NOT NULL,
        features BLOB NOT NULL,
        label INTEGER NOT NULL,
        reward REAL,
        session_id INTEGER REFERENCES game_sessions(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS model_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        games_played INTEGER DEFAULT 0,
        avg_rank REAL,
        avg_score REAL,
        win_rate REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_ticks_session ON battle_ticks(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_game ON game_sessions(game, game_id);
    `)
    log.info('Schema initialized')
  }

  // --- Identity ---
  saveIdentity(game, agentId, apiToken, name) {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_identity (game, agent_id, api_token, name)
      VALUES (?, ?, ?, ?)
    `).run(game, agentId, apiToken, name)
  }

  getIdentity(game) {
    return this.db.prepare('SELECT * FROM agent_identity WHERE game = ?').get(game)
  }

  // --- Game Sessions ---
  startSession(game, gameId, mySlot) {
    const info = this.db.prepare(`
      INSERT INTO game_sessions (game, game_id, my_slot) VALUES (?, ?, ?)
    `).run(game, gameId, mySlot)
    return info.lastInsertRowid
  }

  endSession(sessionId, result, strategyLog) {
    this.db.prepare(`
      UPDATE game_sessions SET ended_at = CURRENT_TIMESTAMP, result = ?, strategy_log = ?
      WHERE id = ?
    `).run(JSON.stringify(result), JSON.stringify(strategyLog), sessionId)
  }

  // --- Battle Ticks ---
  recordTick(sessionId, tick, subTick, state, features, decision) {
    this.db.prepare(`
      INSERT INTO battle_ticks (session_id, tick, sub_tick, state, my_features, my_decision)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, tick, subTick,
      JSON.stringify(state),
      features ? JSON.stringify(features) : null,
      decision ? JSON.stringify(decision) : null
    )
  }

  // Batch insert for performance
  recordTickBatch(rows) {
    const stmt = this.db.prepare(`
      INSERT INTO battle_ticks (session_id, tick, sub_tick, state, my_features, my_decision)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const tx = this.db.transaction((items) => {
      for (const r of items) {
        stmt.run(
          r.sessionId, r.tick, r.subTick,
          JSON.stringify(r.state),
          r.features ? JSON.stringify(r.features) : null,
          r.decision ? JSON.stringify(r.decision) : null
        )
      }
    })
    tx(rows)
  }

  // --- Training Samples ---
  saveSample(modelType, features, label, reward, sessionId) {
    const buf = Buffer.from(Float32Array.from(features).buffer)
    this.db.prepare(`
      INSERT INTO training_samples (model_type, features, label, reward, session_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(modelType, buf, label, reward, sessionId)
  }

  getSampleCount(modelType) {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM training_samples WHERE model_type = ?').get(modelType)
    return row.cnt
  }

  // --- Model Metrics ---
  recordMetrics(modelKey, version, gamesPlayed, avgRank, avgScore, winRate) {
    this.db.prepare(`
      INSERT INTO model_metrics (model_key, version, games_played, avg_rank, avg_score, win_rate)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(modelKey, version, gamesPlayed, avgRank, avgScore, winRate)
  }

  // --- Stats ---
  getSessionCount(game) {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM game_sessions WHERE game = ?').get(game)
    return row.cnt
  }

  getRecentSessions(game, limit = 10) {
    return this.db.prepare(`
      SELECT * FROM game_sessions WHERE game = ? ORDER BY id DESC LIMIT ?
    `).all(game, limit)
  }

  close() {
    this.db.close()
  }
}

module.exports = SqliteStore
