const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const GcV81AutoTrainer = require('../src/core/GcV81AutoTrainer')
const { V81_OPERATION_CONTRACT } = require('../src/config/operationContract')

function fixture() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-v81-auto-train-'))
  const runtimeContext = {
    ...V81_OPERATION_CONTRACT,
    behavior_profile_id: 'hunter',
    behavior_profile_hash: `sha256:${'b'.repeat(64)}`,
    behavior_profile_revision: 3,
  }
  let completedSessions = 0
  let exportCalls = 0
  let trainCalls = 0
  let uploadCalls = 0
  const store = {
    getCompletedTrainingSessionCount: () => completedSessions,
  }
  const exporter = {
    exportForTraining(game, minimum) {
      exportCalls++
      assert.equal(game, 'claw-clash')
      assert.ok(completedSessions >= minimum)
      return {
        sessionCount: completedSessions,
        datasetManifestHash: `sha256:${String(completedSessions).padStart(64, '0')}`,
      }
    },
  }
  const trainer = {
    isRunning: false,
    async run() {
      trainCalls++
      const datasetManifestHash = `sha256:${String(completedSessions).padStart(64, '0')}`
      fs.mkdirSync(outputDir, { recursive: true })
      fs.writeFileSync(path.join(outputDir, 'gc_strategy_model.onnx'), 'test-model')
      fs.writeFileSync(path.join(outputDir, 'meta.json'), JSON.stringify({
        ...runtimeContext,
        action_labels: runtimeContext.strategy_labels,
        observation_policy: 'same_profile_only',
        source_behavior_profile_hashes: [runtimeContext.behavior_profile_hash],
        dataset_session_count: completedSessions,
        dataset_manifest_hash: datasetManifestHash,
        model_checksum: `sha256:${'c'.repeat(64)}`,
      }))
      fs.writeFileSync(path.join(outputDir, 'evaluation.json'), JSON.stringify({
        offline_gates: { shape: true, mask: true },
      }))
      return true
    },
  }
  const api = {
    async uploadModelV8(modelPath, metadata) {
      uploadCalls++
      assert.equal(modelPath, path.join(outputDir, 'gc_strategy_model.onnx'))
      assert.equal(metadata.observation_policy, 'same_profile_only')
      return { revision_id: `revision-${uploadCalls}`, status: 'uploaded' }
    },
  }
  const autoTrainer = new GcV81AutoTrainer({
    store, exporter, trainer, api, runtimeContext, outputDir, threshold: 50,
  })
  return {
    autoTrainer,
    outputDir,
    setCompletedSessions: value => { completedSessions = value },
    calls: () => ({ exportCalls, trainCalls, uploadCalls }),
  }
}

test('v8.1 auto-training waits for the per-profile completed-session threshold', async t => {
  const subject = fixture()
  t.after(() => fs.rmSync(subject.outputDir, { recursive: true, force: true }))
  subject.setCompletedSessions(49)

  assert.deepEqual(await subject.autoTrainer.maybeTrain(), {
    status: 'collecting', sessionCount: 49, required: 50,
  })
  assert.deepEqual(subject.calls(), { exportCalls: 0, trainCalls: 0, uploadCalls: 0 })
})

test('v8.1 auto-training exports, trains, validates, and uploads once per threshold', async t => {
  const subject = fixture()
  t.after(() => fs.rmSync(subject.outputDir, { recursive: true, force: true }))
  subject.setCompletedSessions(50)

  const first = await subject.autoTrainer.maybeTrain()
  assert.equal(first.status, 'uploaded')
  assert.equal(first.revisionId, 'revision-1')
  assert.deepEqual(subject.calls(), { exportCalls: 1, trainCalls: 1, uploadCalls: 1 })

  assert.equal((await subject.autoTrainer.maybeTrain()).status, 'current')
  assert.deepEqual(subject.calls(), { exportCalls: 1, trainCalls: 1, uploadCalls: 1 })

  subject.setCompletedSessions(100)
  const second = await subject.autoTrainer.maybeTrain()
  assert.equal(second.status, 'uploaded')
  assert.equal(second.revisionId, 'revision-2')
  assert.deepEqual(subject.calls(), { exportCalls: 2, trainCalls: 2, uploadCalls: 2 })

  const state = JSON.parse(fs.readFileSync(path.join(subject.outputDir, 'auto-training-state.json')))
  assert.equal(state.status, 'uploaded')
  assert.equal(state.last_success_session_count, 100)
  assert.equal(state.revision_id, 'revision-2')
})

test('v8.1 auto-training rejects cross-profile artifacts before upload', async t => {
  const subject = fixture()
  t.after(() => fs.rmSync(subject.outputDir, { recursive: true, force: true }))
  subject.setCompletedSessions(50)
  const originalRun = subject.autoTrainer.trainer.run
  subject.autoTrainer.trainer.run = async (...args) => {
    const trained = await originalRun(...args)
    const metaPath = path.join(subject.outputDir, 'meta.json')
    const metadata = JSON.parse(fs.readFileSync(metaPath))
    metadata.source_behavior_profile_hashes = [`sha256:${'d'.repeat(64)}`]
    fs.writeFileSync(metaPath, JSON.stringify(metadata))
    return trained
  }

  const result = await subject.autoTrainer.maybeTrain()
  assert.equal(result.status, 'failed')
  assert.match(result.error, /source behavior profile/)
  assert.equal(subject.calls().uploadCalls, 0)
})

test('v8.1 auto-training clears a previous upload error after recovery', async t => {
  const subject = fixture()
  t.after(() => fs.rmSync(subject.outputDir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(subject.outputDir, 'auto-training-state.json'), JSON.stringify({
    status: 'failed',
    attempted_session_count: 50,
    error: 'Request failed with status code 503',
    updated_at: '2026-01-01T00:00:00.000Z',
  }))
  subject.setCompletedSessions(100)

  assert.equal((await subject.autoTrainer.maybeTrain()).status, 'uploaded')

  const state = JSON.parse(fs.readFileSync(path.join(subject.outputDir, 'auto-training-state.json')))
  assert.equal(state.status, 'uploaded')
  assert.equal(Object.hasOwn(state, 'error'), false)
  assert.equal(state.last_success_session_count, 100)
})
