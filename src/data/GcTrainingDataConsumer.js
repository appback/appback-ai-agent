const { createLogger } = require('../utils/logger')
const {
  assertTrainingFrame,
  assertTrainingResult,
  assertTrainingSession,
} = require('./contracts/GcTrainingDataContract')
const log = createLogger('gc-training-consumer')

class GcTrainingDataConsumer {
  constructor({ api, store, runtimeContext, limit = 200 }) {
    this.api = api
    this.store = store
    this.runtimeContext = runtimeContext
    this.expectedFrameContract = {
      operation_version: runtimeContext.operation_version,
      feature_version: runtimeContext.feature_version,
      feature_dim: runtimeContext.feature_dim,
      feature_schema_hash: runtimeContext.feature_schema_hash,
    }
    this.limit = Math.min(Math.max(Number(limit) || 200, 1), 200)
  }

  async syncOnce() {
    const frameResult = await this._syncFrames()
    const resultResult = await this._syncResults()
    return { frames: frameResult, results: resultResult }
  }

  async syncAvailable(maxPages = 10) {
    const limit = Math.min(Math.max(Number(maxPages) || 10, 1), 100)
    const totals = { frames: 0, results: 0, pages: 0 }
    let hasMore = true
    while (hasMore && totals.pages < limit) {
      const page = await this.syncOnce()
      totals.frames += page.frames.inserted
      totals.results += page.results.inserted
      totals.pages++
      hasMore = page.frames.hasMore || page.results.hasMore
    }
    return { ...totals, hasMore }
  }

  async _syncFrames() {
    const after = this.store.getTrainingCursor('frames')
    const response = await this._requestPage('frames', after, () => this.api.getTrainingFrames(after, this.limit))
    const receivedFrames = Array.isArray(response?.data) ? response.data : []
    const frames = []
    const manifests = []
    const sessions = new Map()

    for (const received of receivedFrames) {
      if (received.agent) assertTrainingFrame(received, this.expectedFrameContract)
      let session = sessions.get(received.session_id) || this.store.getTrainingSession(received.session_id)
      if (!session) {
        session = assertTrainingSession(await this.api.getTrainingSession(received.session_id), received.session_id)
        manifests.push(session)
      }
      sessions.set(received.session_id, session)

      // GC 0f2c33b4 exposes agent_slot on the session but omits frame.agent.
      const frame = received.agent ? received : {
        ...received,
        agent: { slot: session.agent_slot },
      }
      frames.push(assertTrainingFrame(frame, this.expectedFrameContract))
    }

    const nextCursor = response?.next_cursor || after
    const inserted = this.store.saveTrainingFrameBatch(frames, manifests, nextCursor)
    if (frames.length > 0) log.info(`Synced training frames: received=${frames.length}, inserted=${inserted}`)
    return { received: receivedFrames.length, inserted, nextCursor, hasMore: Boolean(response?.has_more) }
  }

  async _syncResults() {
    const after = this.store.getTrainingCursor('results')
    const response = await this._requestPage('results', after, () => this.api.getTrainingResults(after, this.limit))
    const results = Array.isArray(response?.data) ? response.data : []
    for (const result of results) assertTrainingResult(result)

    const nextCursor = response?.next_cursor || after
    const inserted = this.store.saveTrainingResultBatch(results, nextCursor)
    if (results.length > 0) log.info(`Synced training results: received=${results.length}, inserted=${inserted}`)
    return { received: results.length, inserted, nextCursor, hasMore: Boolean(response?.has_more) }
  }

  async _requestPage(stream, cursor, request) {
    try {
      return await request()
    } catch (error) {
      if (error?.response?.status !== 410) throw error
      const expired = new Error(`${stream} training cursor expired: ${cursor || '<initial>'}`)
      expired.code = 'TRAINING_CURSOR_EXPIRED'
      expired.stream = stream
      expired.cursor = cursor
      expired.oldestCursor = error.response?.data?.details?.oldest_cursor ||
        error.response?.data?.oldest_cursor || null
      throw expired
    }
  }
}

module.exports = GcTrainingDataConsumer
