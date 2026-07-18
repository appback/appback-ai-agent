const Database = require('better-sqlite3')
const path = require('path')
const { createLogger } = require('../../utils/logger')
const log = createLogger('sqlite')

const LEGACY_CONTEXT = Object.freeze({
  operation_version: 'legacy-unversioned',
  feature_version: 'unknown',
  feature_dim: 0,
  feature_schema_hash: 'unknown',
  training_version: 'unknown',
  behavior_profile_id: 'unknown',
  behavior_profile_hash: 'unknown',
})

class SqliteStore {
  constructor(dataDir, runtimeContext = LEGACY_CONTEXT) {
    const dbPath = path.join(dataDir || './data', 'agent.db')
    this.runtimeContext = { ...LEGACY_CONTEXT, ...runtimeContext }
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

      CREATE TABLE IF NOT EXISTS gc_training_sync_state (
        stream TEXT NOT NULL,
        operation_version TEXT NOT NULL,
        cursor TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (stream, operation_version)
      );

      CREATE TABLE IF NOT EXISTS gc_training_sessions (
        session_id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        operation_version TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS gc_training_frames (
        frame_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        tick INTEGER NOT NULL,
        decision_seq INTEGER NOT NULL,
        operation_version TEXT NOT NULL,
        feature_version TEXT NOT NULL,
        feature_schema_hash TEXT NOT NULL,
        behavior_profile_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (session_id, tick, decision_seq)
      );

      CREATE TABLE IF NOT EXISTS gc_training_results (
        result_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS gc_loadout_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        operation_version TEXT NOT NULL,
        behavior_profile_hash TEXT NOT NULL,
        weapon TEXT NOT NULL,
        armor TEXT NOT NULL,
        rank INTEGER NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (game_id, operation_version, behavior_profile_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_ticks_session ON battle_ticks(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_game ON game_sessions(game, game_id);
      CREATE INDEX IF NOT EXISTS idx_gc_training_frames_session
      ON gc_training_frames(session_id, tick, decision_seq);
      CREATE INDEX IF NOT EXISTS idx_gc_training_results_session
      ON gc_training_results(session_id);
      CREATE INDEX IF NOT EXISTS idx_gc_loadout_results_profile
      ON gc_loadout_results(operation_version, behavior_profile_hash, id);
    `)
    this._migrateOperationScope()
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_operation_profile
      ON game_sessions(game, operation_version, behavior_profile_hash, id);
      CREATE INDEX IF NOT EXISTS idx_samples_operation_profile
      ON training_samples(model_type, operation_version, behavior_profile_hash, id);
    `)
    log.info('Schema initialized')
  }

  _migrateOperationScope() {
    const columns = {
      game_sessions: {
        operation_version: "TEXT NOT NULL DEFAULT 'legacy-unversioned'",
        feature_version: "TEXT NOT NULL DEFAULT 'unknown'",
        feature_dim: 'INTEGER NOT NULL DEFAULT 0',
        feature_schema_hash: "TEXT NOT NULL DEFAULT 'unknown'",
        training_version: "TEXT NOT NULL DEFAULT 'unknown'",
        behavior_profile_id: "TEXT NOT NULL DEFAULT 'unknown'",
        behavior_profile_hash: "TEXT NOT NULL DEFAULT 'unknown'",
      },
      training_samples: {
        operation_version: "TEXT NOT NULL DEFAULT 'legacy-unversioned'",
        feature_version: "TEXT NOT NULL DEFAULT 'unknown'",
        feature_dim: 'INTEGER NOT NULL DEFAULT 0',
        training_version: "TEXT NOT NULL DEFAULT 'unknown'",
        behavior_profile_id: "TEXT NOT NULL DEFAULT 'unknown'",
        behavior_profile_hash: "TEXT NOT NULL DEFAULT 'unknown'",
      },
      model_metrics: {
        operation_version: "TEXT NOT NULL DEFAULT 'legacy-unversioned'",
        training_version: "TEXT NOT NULL DEFAULT 'unknown'",
        behavior_profile_id: "TEXT NOT NULL DEFAULT 'unknown'",
        behavior_profile_hash: "TEXT NOT NULL DEFAULT 'unknown'",
      },
    }

    const migrate = this.db.transaction(() => {
      for (const [table, definitions] of Object.entries(columns)) {
        const existing = new Set(this.db.pragma(`table_info(${table})`).map(column => column.name))
        for (const [name, definition] of Object.entries(definitions)) {
          if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        }
      }
    })
    migrate()
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
    const c = this.runtimeContext
    const info = this.db.prepare(`
      INSERT INTO game_sessions (
        game, game_id, my_slot, operation_version, feature_version, feature_dim,
        feature_schema_hash, training_version, behavior_profile_id, behavior_profile_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      game, gameId, mySlot, c.operation_version, c.feature_version, c.feature_dim,
      c.feature_schema_hash, c.training_version, c.behavior_profile_id, c.behavior_profile_hash
    )
    return info.lastInsertRowid
  }

  endSession(sessionId, result, strategyLog) {
    this.db.prepare(`
      UPDATE game_sessions SET ended_at = CURRENT_TIMESTAMP, result = ?, strategy_log = ?
      WHERE id = ?
    `).run(JSON.stringify(result), JSON.stringify(strategyLog), sessionId)
  }

  dropSession(sessionId) {
    this.db.prepare('DELETE FROM battle_ticks WHERE session_id = ?').run(sessionId)
    this.db.prepare('DELETE FROM game_sessions WHERE id = ?').run(sessionId)
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
    const c = this.runtimeContext
    this.db.prepare(`
      INSERT INTO training_samples (
        model_type, features, label, reward, session_id, operation_version,
        feature_version, feature_dim, training_version, behavior_profile_id, behavior_profile_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      modelType, buf, label, reward, sessionId, c.operation_version,
      c.feature_version, c.feature_dim, c.training_version, c.behavior_profile_id, c.behavior_profile_hash
    )
  }

  getSampleCount(modelType) {
    const c = this.runtimeContext
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM training_samples
      WHERE model_type = ? AND operation_version = ? AND behavior_profile_hash = ?
    `).get(modelType, c.operation_version, c.behavior_profile_hash)
    return row.cnt
  }

  // --- Model Metrics ---
  recordMetrics(modelKey, version, gamesPlayed, avgRank, avgScore, winRate) {
    const c = this.runtimeContext
    this.db.prepare(`
      INSERT INTO model_metrics (
        model_key, version, games_played, avg_rank, avg_score, win_rate,
        operation_version, training_version, behavior_profile_id, behavior_profile_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      modelKey, version, gamesPlayed, avgRank, avgScore, winRate,
      c.operation_version, c.training_version, c.behavior_profile_id, c.behavior_profile_hash
    )
  }

  // --- Stats ---
  getSessionCount(game) {
    const c = this.runtimeContext
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM game_sessions
      WHERE game = ? AND operation_version = ? AND behavior_profile_hash = ?
    `).get(game, c.operation_version, c.behavior_profile_hash)
    return row.cnt
  }

  getRecentSessions(game, limit = 10) {
    const c = this.runtimeContext
    return this.db.prepare(`
      SELECT * FROM game_sessions
      WHERE game = ? AND operation_version = ? AND behavior_profile_hash = ?
      ORDER BY id DESC LIMIT ?
    `).all(game, c.operation_version, c.behavior_profile_hash, limit)
  }

  getCompletedSessions(game) {
    const c = this.runtimeContext
    return this.db.prepare(`
      SELECT * FROM game_sessions
      WHERE game = ? AND operation_version = ? AND behavior_profile_hash = ?
        AND result IS NOT NULL AND result != 'null'
      ORDER BY id
    `).all(game, c.operation_version, c.behavior_profile_hash)
  }

  getCompletedSessionResults(game) {
    return this.getCompletedSessions(game).map(session => ({
      result: session.result,
      strategy_log: session.strategy_log,
    }))
  }

  // --- Personality-scoped equipment performance ---
  saveLoadoutResult(gameId, weapon, armor, result) {
    const c = this.runtimeContext
    return this.db.prepare(`
      INSERT OR IGNORE INTO gc_loadout_results (
        game_id, operation_version, behavior_profile_hash, weapon, armor, rank, score
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      gameId,
      c.operation_version,
      c.behavior_profile_hash,
      weapon,
      armor,
      result.rank,
      result.score || 0
    ).changes
  }

  getLoadoutResults() {
    const c = this.runtimeContext
    return this.db.prepare(`
      SELECT weapon, armor, rank, score
      FROM gc_loadout_results
      WHERE operation_version = ? AND behavior_profile_hash = ?
      ORDER BY id
    `).all(c.operation_version, c.behavior_profile_hash)
  }

  // --- GC v8 Training Feed ---
  getTrainingCursor(stream) {
    const row = this.db.prepare(`
      SELECT cursor FROM gc_training_sync_state
      WHERE stream = ? AND operation_version = ?
    `).get(stream, this.runtimeContext.operation_version)
    return row?.cursor || null
  }

  hasTrainingSession(sessionId) {
    return Boolean(this.db.prepare('SELECT 1 FROM gc_training_sessions WHERE session_id = ?').get(sessionId))
  }

  getTrainingSession(sessionId) {
    const row = this.db.prepare('SELECT payload FROM gc_training_sessions WHERE session_id = ?').get(sessionId)
    return row ? JSON.parse(row.payload) : null
  }

  saveTrainingFrameBatch(frames, manifests, nextCursor) {
    const sessionStmt = this.db.prepare(`
      INSERT OR IGNORE INTO gc_training_sessions (session_id, game_id, operation_version, payload)
      VALUES (?, ?, ?, ?)
    `)
    const frameStmt = this.db.prepare(`
      INSERT OR IGNORE INTO gc_training_frames (
        frame_id, cursor, session_id, game_id, tick, decision_seq, operation_version,
        feature_version, feature_schema_hash, behavior_profile_hash, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const syncStmt = this.db.prepare(`
      INSERT INTO gc_training_sync_state (stream, operation_version, cursor, updated_at)
      VALUES ('frames', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(stream, operation_version) DO UPDATE SET
        cursor = excluded.cursor,
        updated_at = CURRENT_TIMESTAMP
    `)
    const existingSessionStmt = this.db.prepare(`
      SELECT payload FROM gc_training_sessions WHERE session_id = ?
    `)
    const existingFrameStmt = this.db.prepare(`
      SELECT payload FROM gc_training_frames
      WHERE frame_id = ? OR cursor = ? OR (session_id = ? AND tick = ? AND decision_seq = ?)
      LIMIT 1
    `)
    const tx = this.db.transaction(() => {
      for (const session of manifests) {
        const stored = sessionStmt.run(
          session.session_id,
          session.game_id,
          this.runtimeContext.operation_version,
          JSON.stringify(session)
        )
        if (stored.changes === 0) {
          this._assertImmutableRecord(
            'training session',
            session.session_id,
            existingSessionStmt.get(session.session_id)?.payload,
            session
          )
        }
      }
      let inserted = 0
      for (const frame of frames) {
        const stored = frameStmt.run(
          frame.frame_id,
          frame.cursor,
          frame.session_id,
          frame.game_id,
          frame.tick,
          frame.decision_seq,
          frame.contract.operation_version,
          frame.contract.feature_version,
          frame.contract.feature_schema_hash,
          frame.behavior_profile.hash,
          JSON.stringify(frame)
        )
        inserted += stored.changes
        if (stored.changes === 0) {
          this._assertImmutableRecord(
            'training frame',
            frame.frame_id,
            existingFrameStmt.get(
              frame.frame_id,
              frame.cursor,
              frame.session_id,
              frame.tick,
              frame.decision_seq
            )?.payload,
            frame
          )
        }
      }
      if (nextCursor) syncStmt.run(this.runtimeContext.operation_version, nextCursor)
      return inserted
    })
    return tx()
  }

  saveTrainingResultBatch(results, nextCursor) {
    const resultStmt = this.db.prepare(`
      INSERT OR IGNORE INTO gc_training_results (result_id, cursor, session_id, game_id, payload)
      VALUES (?, ?, ?, ?, ?)
    `)
    const syncStmt = this.db.prepare(`
      INSERT INTO gc_training_sync_state (stream, operation_version, cursor, updated_at)
      VALUES ('results', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(stream, operation_version) DO UPDATE SET
        cursor = excluded.cursor,
        updated_at = CURRENT_TIMESTAMP
    `)
    const existingResultStmt = this.db.prepare(`
      SELECT payload FROM gc_training_results
      WHERE result_id = ? OR cursor = ?
      LIMIT 1
    `)
    const tx = this.db.transaction(() => {
      let inserted = 0
      for (const result of results) {
        const stored = resultStmt.run(
          result.result_id,
          result.cursor,
          result.session_id,
          result.game_id,
          JSON.stringify(result)
        )
        inserted += stored.changes
        if (stored.changes === 0) {
          this._assertImmutableRecord(
            'training result',
            result.result_id,
            existingResultStmt.get(result.result_id, result.cursor)?.payload,
            result
          )
        }
      }
      if (nextCursor) syncStmt.run(this.runtimeContext.operation_version, nextCursor)
      return inserted
    })
    return tx()
  }

  _assertImmutableRecord(kind, id, storedPayload, incoming) {
    if (!storedPayload || stableStringify(JSON.parse(storedPayload)) !== stableStringify(incoming)) {
      throw new Error(`${kind} conflict for immutable record: ${id}`)
    }
  }

  getTrainingFeedCounts() {
    return {
      sessions: this.db.prepare('SELECT COUNT(*) AS count FROM gc_training_sessions').get().count,
      frames: this.db.prepare('SELECT COUNT(*) AS count FROM gc_training_frames').get().count,
      results: this.db.prepare('SELECT COUNT(*) AS count FROM gc_training_results').get().count,
    }
  }

  getCompletedTrainingSessionCount() {
    const c = this.runtimeContext
    return this.db.prepare(`
      SELECT COUNT(DISTINCT tr.session_id) AS count
      FROM gc_training_results tr
      JOIN gc_training_sessions ts ON ts.session_id = tr.session_id
      JOIN gc_training_frames gf ON gf.session_id = ts.session_id
      WHERE ts.operation_version = ? AND gf.operation_version = ?
        AND gf.behavior_profile_hash = ?
        AND json_extract(tr.payload, '$.completed') = 1
    `).get(c.operation_version, c.operation_version, c.behavior_profile_hash).count
  }

  getTrainingFeedForExport(options = {}) {
    const operationVersion = this.runtimeContext.operation_version
    const profileHash = this.runtimeContext.behavior_profile_hash
    const reuseObservations = Boolean(options.reuseObservations)
    const queryArgs = [operationVersion, operationVersion, reuseObservations ? 1 : 0, profileHash]
    const sessions = this.db.prepare(`
      SELECT DISTINCT ts.session_id, ts.payload, ts.received_at
      FROM gc_training_sessions ts
      JOIN gc_training_frames gf ON gf.session_id = ts.session_id
      WHERE ts.operation_version = ? AND gf.operation_version = ?
        AND (? = 1 OR gf.behavior_profile_hash = ?)
      ORDER BY ts.received_at, ts.session_id
    `).all(...queryArgs).map(row => JSON.parse(row.payload))
    const results = this.db.prepare(`
      SELECT DISTINCT tr.session_id, tr.payload, tr.received_at, tr.result_id
      FROM gc_training_results tr
      JOIN gc_training_sessions ts ON ts.session_id = tr.session_id
      JOIN gc_training_frames gf ON gf.session_id = ts.session_id
      WHERE ts.operation_version = ? AND gf.operation_version = ?
        AND (? = 1 OR gf.behavior_profile_hash = ?)
      ORDER BY tr.received_at, tr.result_id
    `).all(...queryArgs).map(row => JSON.parse(row.payload))
    const frames = this.db.prepare(`
      SELECT gf.payload
      FROM gc_training_frames gf
      JOIN gc_training_sessions ts ON ts.session_id = gf.session_id
      WHERE ts.operation_version = ? AND gf.operation_version = ?
        AND (? = 1 OR gf.behavior_profile_hash = ?)
      ORDER BY gf.received_at, gf.cursor
    `).all(...queryArgs).map(row => JSON.parse(row.payload))
    const sourceBehaviorProfileHashes = [...new Set(frames
      .map(frame => frame.behavior_profile?.hash)
      .filter(Boolean))].sort()
    return { sessions, frames, results, sourceBehaviorProfileHashes, reuseObservations }
  }

  close() {
    this.db.close()
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

module.exports = SqliteStore
