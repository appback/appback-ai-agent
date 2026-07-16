const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { createLogger } = require('../../utils/logger')
const { GcV8Teacher } = require('../../training/GcV8Teacher')
const { GcStrategyV81Teacher } = require('../../training/GcStrategyV81Teacher')
const log = createLogger('exporter')

class TrainingExporter {
  constructor(store, exportDir, runtimeContext = store.runtimeContext, behaviorProfile = null, options = {}) {
    this.store = store
    this.exportDir = exportDir || './training/data/raw'
    this.runtimeContext = Object.freeze({ ...runtimeContext })
    this.behaviorProfile = behaviorProfile
      ? JSON.parse(JSON.stringify(behaviorProfile))
      : null
    this.reuseObservations = Boolean(options.reuseObservations)
  }

  exportForTraining(game, minSessions = 10) {
    if (this.runtimeContext.feature_version === '8.0' || this.runtimeContext.feature_version === '8.1') {
      return this.exportV8ForTraining(game, minSessions)
    }
    const sessions = this.store.getCompletedSessions(game)

    if (sessions.length < minSessions) {
      log.info(`Not enough sessions (${sessions.length}/${minSessions}), skipping export`)
      return null
    }

    fs.mkdirSync(this.exportDir, { recursive: true })
    const manifestPath = path.join(this.exportDir, 'operation-manifest.json')
    fs.writeFileSync(manifestPath, `${JSON.stringify(this.runtimeContext, null, 2)}\n`)

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
      operation_version: s.operation_version,
      feature_version: s.feature_version,
      feature_dim: s.feature_dim,
      behavior_profile_id: s.behavior_profile_id,
      behavior_profile_hash: s.behavior_profile_hash,
    }))
    fs.writeFileSync(sessionsPath, JSON.stringify(sessionData, null, 2))
    log.info(`Exported ${sessions.length} sessions → ${sessionsPath}`)

    // Export tick data with features
    const ticksPath = path.join(this.exportDir, `${game}_ticks.csv`)
    const tickStmt = this.store.db.prepare(`
      SELECT bt.*, gs.result as game_result, gs.my_slot
      FROM battle_ticks bt
      JOIN game_sessions gs ON gs.id = bt.session_id
      WHERE gs.game = ? AND gs.operation_version = ? AND gs.behavior_profile_hash = ?
        AND bt.my_features IS NOT NULL AND bt.my_decision IS NOT NULL
        AND gs.result IS NOT NULL AND gs.result != 'null'
      ORDER BY bt.session_id, bt.tick, bt.sub_tick
    `)

    const ticks = tickStmt.all(
      game,
      this.runtimeContext.operation_version,
      this.runtimeContext.behavior_profile_hash
    )
    if (ticks.length === 0) {
      log.info('No tick data with features to export')
      return sessionsPath
    }

    // CSV header: session_id, tick, sub_tick, f0, f1, ..., f152, action, rank, score
    const featureCount = this.runtimeContext.feature_dim
    const header = ['session_id', 'tick', 'sub_tick']
    for (let i = 0; i < featureCount; i++) header.push(`f${i}`)
    header.push('action', 'rank', 'score')

    const lines = [header.join(',')]
    for (const t of ticks) {
      const features = JSON.parse(t.my_features)
      let result
      try { result = JSON.parse(t.game_result) } catch { result = null }
      if (!result || typeof result !== 'object') continue
      if (features.length !== featureCount) continue
      const decision = JSON.parse(t.my_decision || 'null')
      const action = decision?.action || ''
      if (!action) continue
      const row = [t.session_id, t.tick, t.sub_tick]
      row.push(...features)
      row.push(action, result.rank || result.placement || 0, result.score || 0)
      lines.push(row.join(','))
    }

    fs.writeFileSync(ticksPath, lines.join('\n'))
    log.info(`Exported ${ticks.length} tick features → ${ticksPath}`)

    return { manifestPath, sessionsPath, ticksPath, sessionCount: sessions.length, tickCount: lines.length - 1 }
  }

  exportV8ForTraining(game, minSessions = 10) {
    const feed = this.store.getTrainingFeedForExport({ reuseObservations: this.reuseObservations })
    const resultBySession = new Map(feed.results
      .filter(result => result.completed)
      .map(result => [result.session_id, result]))
    const sessions = feed.sessions.filter(session => resultBySession.has(session.session_id))
    if (sessions.length < minSessions) {
      log.info(`Not enough completed v8 sessions (${sessions.length}/${minSessions}), skipping export`)
      return null
    }

    const sessionById = new Map(sessions.map(session => [session.session_id, session]))
    const strategyModel = this.runtimeContext.feature_version === '8.1'
    const teacher = strategyModel
      ? new GcStrategyV81Teacher(this.behaviorProfile)
      : new GcV8Teacher(this.behaviorProfile)
    const featureCount = this.runtimeContext.feature_dim
    const samples = []
    for (const frame of feed.frames) {
      const session = sessionById.get(frame.session_id)
      const result = resultBySession.get(frame.session_id)
      if (!session || !result || frame.input?.feature_vector?.length !== featureCount) continue
      const label = teacher.buildSample(frame, session, result)
      samples.push({ frame, result, label })
    }
    if (samples.length === 0) {
      log.info('No valid v8 decision frames to export')
      return null
    }

    fs.mkdirSync(this.exportDir, { recursive: true })
    const datasetDescriptor = {
      operation_version: this.runtimeContext.operation_version,
      feature_schema_hash: this.runtimeContext.feature_schema_hash,
      behavior_profile_hash: this.runtimeContext.behavior_profile_hash,
      observation_policy: this.reuseObservations ? 'reuse_and_relabel' : 'same_profile_only',
      source_behavior_profile_hashes: feed.sourceBehaviorProfileHashes,
      sessions: sessions.map(session => session.session_id),
      samples: samples.map(sample => ({
        frame_id: sample.frame.frame_id,
        feature_vector: sample.frame.input.feature_vector,
        teacher_label: strategyModel ? sample.label.teacher_strategy : sample.label.teacher_action,
        sample_weight: sample.label.sample_weight,
      })),
    }
    const datasetDigest = crypto.createHash('sha256')
      .update(JSON.stringify(datasetDescriptor))
      .digest('hex')
    const manifest = {
      ...this.runtimeContext,
      dataset_manifest_hash: `sha256:${datasetDigest}`,
      dataset_session_count: sessions.length,
      dataset_session_from: sessions[0].session_id,
      dataset_session_to: sessions[sessions.length - 1].session_id,
      sample_count: samples.length,
      label_source: strategyModel ? 'strategy_teacher_v8_1' : 'bfs_teacher',
      observation_policy: datasetDescriptor.observation_policy,
      source_behavior_profile_hashes: datasetDescriptor.source_behavior_profile_hashes,
      generated_at: new Date().toISOString(),
    }
    const manifestPath = path.join(this.exportDir, 'operation-manifest.json')
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const sessionsPath = path.join(this.exportDir, `${game}_sessions.json`)
    fs.writeFileSync(sessionsPath, `${JSON.stringify(sessions.map(session => ({
      ...session,
      result: resultBySession.get(session.session_id),
    })), null, 2)}\n`)

    const ticksPath = path.join(this.exportDir, `${game}_ticks.csv`)
    const header = ['session_id', 'frame_id', 'tick']
    for (let i = 0; i < featureCount; i++) header.push(`f${i}`)
    header.push(
      strategyModel ? 'strategy' : 'action',
      'sample_weight',
      strategyModel ? 'observed_strategy' : 'observed_action',
      strategyModel ? 'executed_strategy' : 'executed_action',
      'teacher_reason', 'rank', 'score'
    )
    const lines = [header.join(',')]
    for (const sample of samples) {
      const row = [sample.frame.session_id, sample.frame.frame_id, sample.frame.tick]
      row.push(...sample.frame.input.feature_vector)
      row.push(
        strategyModel ? sample.label.teacher_strategy : sample.label.teacher_action,
        sample.label.sample_weight,
        strategyModel ? sample.label.observed_strategy : sample.label.observed_action,
        strategyModel ? sample.label.executed_strategy : sample.label.executed_action,
        sample.label.teacher_reason,
        sample.result.rank,
        sample.result.score
      )
      lines.push(row.join(','))
    }
    fs.writeFileSync(ticksPath, `${lines.join('\n')}\n`)
    log.info(`Exported ${samples.length} authoritative v8 samples from ${sessions.length} sessions`)
    return {
      manifestPath,
      sessionsPath,
      ticksPath,
      sessionCount: sessions.length,
      tickCount: samples.length,
      datasetManifestHash: manifest.dataset_manifest_hash,
    }
  }
}

module.exports = TrainingExporter
