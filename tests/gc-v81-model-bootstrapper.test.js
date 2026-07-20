const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const test = require('node:test')
const GcV81ModelBootstrapper = require('../src/core/GcV81ModelBootstrapper')

const assetsRoot = path.join(__dirname, '..', 'bootstrap', 'gc-v8.1')
const balancedMeta = JSON.parse(fs.readFileSync(path.join(assetsRoot, 'balanced', 'meta.json'), 'utf8'))

function runtime(overrides = {}) {
  return {
    feature_version: '8.1',
    behavior_profile_id: 'balanced',
    behavior_profile_hash: balancedMeta.behavior_profile_hash,
    behavior_profile_revision: 1,
    ...overrides,
  }
}

test('bootstrap waits until GC advertises server-owned rollout', async () => {
  let calls = 0
  const subject = new GcV81ModelBootstrapper({
    api: { listModelsV8: async () => { calls++; return { revisions: [] } } },
    runtimeContext: runtime(),
    assetsRoot,
  })
  assert.deepEqual(await subject.ensure({}), { status: 'server_unsupported' })
  assert.equal(calls, 0)
})

test('bootstrap does not upload an existing profile revision', async () => {
  let uploads = 0
  const subject = new GcV81ModelBootstrapper({
    api: {
      listModelsV8: async () => ({ revisions: [{
        revision_id: 'existing',
        feature_version: '8.1',
        feature_schema_hash: balancedMeta.feature_schema_hash,
        behavior_profile_hash: balancedMeta.behavior_profile_hash,
      }] }),
      uploadModelV8: async () => { uploads++; },
    },
    runtimeContext: runtime(),
    assetsRoot,
  })
  assert.deepEqual(await subject.ensure({ model_auto_rollout: true }), {
    status: 'current', revisionId: 'existing',
  })
  assert.equal(uploads, 0)
})

test('bootstrap uploads a checksummed preset model for the effective profile revision', async () => {
  let uploaded = null
  const variedHash = `sha256:${'a'.repeat(64)}`
  const subject = new GcV81ModelBootstrapper({
    api: {
      listModelsV8: async () => ({ revisions: [] }),
      uploadModelV8: async (modelPath, metadata) => {
        uploaded = { modelPath, metadata }
        return { revision_id: 'new-revision' }
      },
    },
    runtimeContext: runtime({ behavior_profile_hash: variedHash, behavior_profile_revision: 7 }),
    assetsRoot,
  })
  assert.deepEqual(await subject.ensure({ model_auto_rollout: true }), {
    status: 'uploaded', revisionId: 'new-revision', profileId: 'balanced',
  })
  assert.equal(uploaded.modelPath, path.join(assetsRoot, 'balanced', 'gc_strategy_model.onnx'))
  assert.equal(uploaded.metadata.behavior_profile_hash, variedHash)
  assert.equal(uploaded.metadata.behavior_profile_revision, 7)
  assert.equal(uploaded.metadata.observation_policy, 'synthetic_bootstrap')
})

test('bootstrap refuses an unsupported custom personality instead of mislabelling a model', async () => {
  let calls = 0
  const subject = new GcV81ModelBootstrapper({
    api: { listModelsV8: async () => { calls++; return { revisions: [] } } },
    runtimeContext: runtime({ behavior_profile_id: 'custom-tactician' }),
    assetsRoot,
  })
  assert.deepEqual(await subject.ensure({ model_auto_rollout: true }), {
    status: 'profile_unsupported', profileId: 'custom-tactician',
  })
  assert.equal(calls, 0)
})
