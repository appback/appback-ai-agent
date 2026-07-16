const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const GcApiClient = require('../src/adapters/gc/GcApiClient')
const packageVersion = require('../package.json').version
const {
  buildAgentHeaders,
  createClientContract,
  evaluateServerContract,
  isVersionAtLeast,
} = require('../src/config/GcServerContract')

test('v7 bridge sends the deployed protocol and agent version headers', () => {
  const contract = createClientContract(packageVersion, '7.0')
  assert.deepEqual(buildAgentHeaders(contract), {
    'X-GC-Protocol-Version': '1',
    'X-AI-Agent-Version': packageVersion,
  })

  const api = new GcApiClient({ apiUrl: 'https://example.invalid/api/v1' }, contract)
  assert.equal(api.client.defaults.headers['X-GC-Protocol-Version'], '1')
  assert.equal(api.client.defaults.headers['X-AI-Agent-Version'], packageVersion)
})

test('observe reports incompatibility without blocking the running v7 agent', () => {
  const status = evaluateServerContract({
    protocol_version: 1,
    enforcement: 'observe',
    accepted_feature_versions: ['8.0'],
    required_feature_version: null,
    minimum_agent_version: null,
  }, createClientContract('2.2.1', '7.0'))

  assert.equal(status.compatible, false)
  assert.match(status.warnings[0], /feature=7.0/)
})

test('strict rejects a v7 feature contract and an outdated agent version', () => {
  assert.throws(() => evaluateServerContract({
    protocol_version: 1,
    enforcement: 'strict',
    accepted_feature_versions: ['8.0'],
    required_feature_version: '8.0',
    minimum_agent_version: '3.0.0',
  }, createClientContract('2.2.1', '7.0')), /GC strict contract rejected/)

  assert.equal(isVersionAtLeast('3.0.0', '3.0.0'), true)
  assert.equal(isVersionAtLeast('3.1.0', '3.0.9'), true)
  assert.equal(isVersionAtLeast('2.9.9', '3.0.0'), false)
  assert.equal(isVersionAtLeast('3.0.0-rc.1', '3.0.0'), false)
  assert.equal(isVersionAtLeast('3.0.0', '3.0.0-rc.1'), true)
  assert.equal(isVersionAtLeast('3.0.0-beta.11', '3.0.0-beta.2'), true)
  assert.equal(isVersionAtLeast('not-semver', '3.0.0'), false)
})

test('v8 model upload uses the immutable revision endpoint with metadata', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-v8-upload-'))
  const modelPath = path.join(tempDir, 'model.onnx')
  fs.writeFileSync(modelPath, 'fake-onnx-model')
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  const api = new GcApiClient({ apiUrl: 'https://example.invalid/api/v1' })
  const metadata = { operation_version: 'gc-v8-r1' }
  api.client.post = async (url, form, options) => {
    assert.equal(url, '/agents/me/models/v8')
    assert.match(options.headers['content-type'], /^multipart\/form-data; boundary=/)
    assert.ok(form._streams.some(stream => stream === JSON.stringify(metadata)))
    return { data: { revision_id: 'revision-1', status: 'uploaded' } }
  }

  assert.deepEqual(await api.uploadModelV8(modelPath, metadata), {
    revision_id: 'revision-1',
    status: 'uploaded',
  })
  await assert.rejects(api.uploadModelV8(modelPath, null), /metadata must be an object/)
})

test('v8 model revisions are listed through the v8 endpoint', async () => {
  const api = new GcApiClient({ apiUrl: 'https://example.invalid/api/v1' })
  api.client.get = async url => {
    assert.equal(url, '/agents/me/models/v8')
    return { data: { models: [{ revision_id: 'revision-1' }] } }
  }
  assert.deepEqual(await api.listModelsV8(), { models: [{ revision_id: 'revision-1' }] })
})
