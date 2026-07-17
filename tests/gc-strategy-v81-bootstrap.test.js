const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { PROFILE_NAMES, generateSyntheticBootstrap } = require('../src/training/GcStrategyV81SyntheticBootstrap')

test('v8.1 synthetic bootstrap is deterministic and isolates all four profiles', () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-v81-bootstrap-a-'))
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-v81-bootstrap-b-'))
  const options = { sessionsPerProfile: 6, samplesPerSession: 6, seed: 8107 }
  const first = generateSyntheticBootstrap({ ...options, outputRoot: firstRoot })
  const second = generateSyntheticBootstrap({ ...options, outputRoot: secondRoot })

  assert.deepEqual(first.summaries.map(summary => summary.profile), PROFILE_NAMES)
  assert.deepEqual(
    first.summaries.map(summary => [summary.profileHash, summary.datasetManifestHash, summary.labelCounts]),
    second.summaries.map(summary => [summary.profileHash, summary.datasetManifestHash, summary.labelCounts]),
  )
  for (const summary of first.summaries) {
    assert.equal(summary.sessionCount, 6)
    assert.equal(summary.sampleCount, 36)
    const manifest = JSON.parse(fs.readFileSync(path.join(summary.outputDir, 'operation-manifest.json'), 'utf8'))
    assert.equal(manifest.feature_version, '8.1')
    assert.equal(manifest.feature_dim, 214)
    assert.equal(manifest.output_dim, 11)
    assert.equal(manifest.observation_policy, 'synthetic_bootstrap')
    assert.deepEqual(manifest.source_behavior_profile_hashes, [])
    assert.match(manifest.dataset_session_from, /^[0-9a-f-]{36}$/)
    const lines = fs.readFileSync(path.join(summary.outputDir, 'claw-clash_ticks.csv'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 37)
    assert.equal(lines[0].split(',').filter(column => /^f\d+$/.test(column)).length, 214)
  }
})
