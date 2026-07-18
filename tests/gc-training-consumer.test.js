const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const SqliteStore = require('../src/data/storage/SqliteStore')
const GcTrainingDataConsumer = require('../src/data/GcTrainingDataConsumer')
const GcApiClient = require('../src/adapters/gc/GcApiClient')

const HASH = `sha256:${'a'.repeat(64)}`
const PROFILE_HASH = `sha256:${'b'.repeat(64)}`

function runtime() {
  return {
    operation_version: 'gc-v8-r1',
    feature_version: '8.0',
    feature_dim: 192,
    feature_schema_hash: HASH,
    training_version: 'teacher-v8-r1',
    output_dim: 5,
    behavior_profile_id: 'navigator',
    behavior_profile_hash: `sha256:${'c'.repeat(64)}`,
  }
}

function frame(overrides = {}) {
  return {
    record_version: 1,
    frame_id: 'frame-1',
    cursor: 'tf1:1',
    session_id: 'session-1',
    game_id: 'game-1',
    tick: 42,
    phase: 'move',
    sub_tick: 1,
    decision_seq: 3,
    agent: { slot: 3 },
    contract: {
      operation_version: 'gc-v8-r1',
      feature_version: '8.0',
      feature_dim: 192,
      feature_schema_hash: HASH,
      training_version: 'collection-v8-r1',
    },
    behavior_profile: { id: 'balanced', revision: 1, hash: PROFILE_HASH },
    model: { revision_id: 'revision-1', checksum: HASH },
    input: { feature_vector: new Array(192).fill(0), action_mask: [1, 1, 0, 1, 1] },
    inference: { status: 'ok', latency_us: 840, raw_argmax_action: 'up', model_action: 'left' },
    execution: {
      executed_action: 'stay',
      execution_status: 'blocked_dynamic',
      override_reason: 'dynamic_collision',
      position_before: { x: 4, y: 3 },
      position_after: { x: 4, y: 3 },
    },
    history_before: {},
    state: { agents: [], powerups: [], shrink: null, safe_zone: null, events_since_previous_frame: [] },
    terrain_ref: { session_id: 'session-1', terrain_version: HASH },
    capabilities: { powerups: false, shrink_safe_zone: false },
    cohort: 'canary',
    created_at: '2026-07-16T12:00:00Z',
    ...overrides,
  }
}

function result() {
  return {
    result_id: 'result-1',
    cursor: 'tr1:1',
    session_id: 'session-1',
    game_id: 'game-1',
    agent_slot: 3,
    rank: 2,
    score: 420,
    kills: 3,
    damage_dealt: 280,
    damage_taken: 190,
    survived_ticks: 271,
    completed: true,
    finish_reason: 'last_standing',
    created_at: '2026-07-16T12:04:30Z',
  }
}

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-training-consumer-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir)
  return new SqliteStore(dataDir, runtime())
}

test('consumer persists frames/results and advances cursors atomically', async () => {
  const store = createStore()
  let sessionRequests = 0
  const api = {
    async getTrainingFrames(after) {
      assert.equal(after, null)
      return { data: [frame()], next_cursor: 'tf1:1', has_more: false }
    },
    async getTrainingSession(sessionId) {
      sessionRequests++
      return { session_id: sessionId, game_id: 'game-1', terrain: [[0]], max_ticks: 300 }
    },
    async getTrainingResults(after) {
      assert.equal(after, null)
      return { data: [result()], next_cursor: 'tr1:1', has_more: false }
    },
  }

  const synced = await new GcTrainingDataConsumer({ api, store, runtimeContext: runtime() }).syncOnce()
  assert.equal(synced.frames.inserted, 1)
  assert.equal(synced.results.inserted, 1)
  assert.equal(sessionRequests, 1)
  assert.deepEqual(store.getTrainingFeedCounts(), { sessions: 1, frames: 1, results: 1 })
  assert.equal(store.getCompletedTrainingSessionCount(), 1)
  assert.equal(store.getTrainingCursor('frames'), 'tf1:1')
  assert.equal(store.getTrainingCursor('results'), 'tr1:1')
  store.close()
})

test('consumer drains available frame pages while keeping frame/result cursors independent', async () => {
  const store = createStore()
  let frameCalls = 0
  let resultCalls = 0
  const secondFrame = frame({ frame_id: 'frame-2', cursor: 'tf1:2', tick: 43 })
  const api = {
    async getTrainingFrames(after) {
      frameCalls++
      if (after === null) return { data: [frame()], next_cursor: 'tf1:1', has_more: true }
      if (after === 'tf1:1') return { data: [secondFrame], next_cursor: 'tf1:2', has_more: false }
      return { data: [], next_cursor: after, has_more: false }
    },
    async getTrainingSession(sessionId) { return { session_id: sessionId, game_id: 'game-1' } },
    async getTrainingResults(after) {
      resultCalls++
      return { data: after ? [] : [result()], next_cursor: after || 'tr1:1', has_more: false }
    },
  }

  const synced = await new GcTrainingDataConsumer({ api, store, runtimeContext: runtime() }).syncAvailable()
  assert.deepEqual(synced, { frames: 2, results: 1, pages: 2, hasMore: false })
  assert.equal(frameCalls, 2)
  assert.equal(resultCalls, 2)
  assert.equal(store.getTrainingCursor('frames'), 'tf1:2')
  assert.equal(store.getTrainingCursor('results'), 'tr1:1')
  store.close()
})

test('consumer deduplicates immutable records on replay', async () => {
  const store = createStore()
  const api = {
    async getTrainingFrames() { return { data: [frame()], next_cursor: 'tf1:1', has_more: false } },
    async getTrainingSession() { return { session_id: 'session-1', game_id: 'game-1' } },
    async getTrainingResults() { return { data: [result()], next_cursor: 'tr1:1', has_more: false } },
  }
  const consumer = new GcTrainingDataConsumer({ api, store, runtimeContext: runtime() })
  await consumer.syncOnce()
  const replayed = await consumer.syncOnce()
  assert.equal(replayed.frames.inserted, 0)
  assert.equal(replayed.results.inserted, 0)
  assert.deepEqual(store.getTrainingFeedCounts(), { sessions: 1, frames: 1, results: 1 })
  store.close()
})

test('consumer rejects an immutable frame conflict without advancing the cursor', async () => {
  const store = createStore()
  store.saveTrainingFrameBatch(
    [frame()],
    [{ session_id: 'session-1', game_id: 'game-1' }],
    'tf1:1'
  )
  const changed = frame({
    execution: { ...frame().execution, executed_action: 'left', execution_status: 'applied' },
  })

  assert.throws(
    () => store.saveTrainingFrameBatch([changed], [], 'tf1:2'),
    /training frame conflict for immutable record/
  )
  assert.equal(store.getTrainingCursor('frames'), 'tf1:1')
  assert.equal(store.getTrainingFeedCounts().frames, 1)
  store.close()
})

test('consumer rejects a mismatched schema without advancing the cursor', async () => {
  const store = createStore()
  const badFrame = frame({
    contract: { ...frame().contract, feature_schema_hash: `sha256:${'d'.repeat(64)}` },
  })
  const api = {
    async getTrainingFrames() { return { data: [badFrame], next_cursor: 'tf1:1', has_more: false } },
    async getTrainingSession() { throw new Error('must not fetch session for rejected frame') },
    async getTrainingResults() { return { data: [], next_cursor: null, has_more: false } },
  }
  const consumer = new GcTrainingDataConsumer({ api, store, runtimeContext: runtime() })
  await assert.rejects(consumer.syncOnce(), /feature_schema_hash mismatch/)
  assert.equal(store.getTrainingCursor('frames'), null)
  assert.deepEqual(store.getTrainingFeedCounts(), { sessions: 0, frames: 0, results: 0 })
  store.close()
})

test('validator accepts the nullable override emitted by the GC v8 runtime', async () => {
  const store = createStore()
  const applied = frame({
    execution: {
      ...frame().execution,
      executed_action: 'left',
      execution_status: 'applied',
      override_reason: null,
    },
  })
  const api = {
    async getTrainingFrames() { return { data: [applied], next_cursor: 'tf1:1', has_more: false } },
    async getTrainingSession() { return { session_id: 'session-1', game_id: 'game-1' } },
    async getTrainingResults() { return { data: [], next_cursor: 'tr1:AAAAAAAAAAA', has_more: false } },
  }

  const synced = await new GcTrainingDataConsumer({ api, store, runtimeContext: runtime() }).syncOnce()
  assert.equal(synced.frames.inserted, 1)
  store.close()
})

test('consumer fills the GC runtime omitted frame agent slot from the session manifest', async () => {
  const store = createStore()
  const withoutAgent = frame()
  delete withoutAgent.agent
  const api = {
    async getTrainingFrames() { return { data: [withoutAgent], next_cursor: 'tf1:1', has_more: false } },
    async getTrainingSession() { return { session_id: 'session-1', game_id: 'game-1', agent_slot: 3 } },
    async getTrainingResults() { return { data: [], next_cursor: 'tr1:AAAAAAAAAAA', has_more: false } },
  }

  const synced = await new GcTrainingDataConsumer({ api, store, runtimeContext: runtime() }).syncOnce()
  assert.equal(synced.frames.inserted, 1)
  const stored = JSON.parse(store.db.prepare('SELECT payload FROM gc_training_frames').get().payload)
  assert.deepEqual(stored.agent, { slot: 3 })
  store.close()
})

test('consumer reports an expired server cursor without changing local state', async () => {
  const store = createStore()
  store.saveTrainingFrameBatch([], [], 'tf1:old')
  const api = {
    async getTrainingFrames(after) {
      assert.equal(after, 'tf1:old')
      const error = new Error('gone')
      error.response = {
        status: 410,
        data: {
          error: 'TRAINING_CURSOR_EXPIRED',
          message: 'Training frame cursor is outside the retention window',
          details: { oldest_cursor: 'tf1:new' },
        },
      }
      throw error
    },
    async getTrainingResults() { throw new Error('must not continue after cursor expiration') },
  }
  const consumer = new GcTrainingDataConsumer({ api, store, runtimeContext: runtime() })

  await assert.rejects(
    consumer.syncOnce(),
    error => error.code === 'TRAINING_CURSOR_EXPIRED' && error.oldestCursor === 'tf1:new'
  )
  assert.equal(store.getTrainingCursor('frames'), 'tf1:old')
  store.close()
})

test('API client uses the agreed frame/result/session endpoints and cursor params', async () => {
  const api = new GcApiClient({ apiUrl: 'https://example.invalid/api/v1' })
  const requests = []
  api.client.defaults.adapter = async config => {
    requests.push({ url: config.url, params: config.params })
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
  }

  await api.getTrainingFrames('tf1:10', 100)
  await api.getTrainingResults('tr1:20', 50)
  await api.getTrainingSession('session/unsafe')

  assert.deepEqual(requests, [
    { url: '/agents/me/training-frames', params: { after: 'tf1:10', limit: 100 } },
    { url: '/agents/me/training-results', params: { after: 'tr1:20', limit: 50 } },
    { url: '/agents/me/training-sessions/session%2Funsafe', params: undefined },
  ])
})
