const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const Database = require('better-sqlite3')
const { OperationVersionStore } = require('../src/config/OperationVersionStore')
const {
  CURRENT_OPERATION_CONTRACT,
  V8_OPERATION_CONTRACT,
  V81_OPERATION_CONTRACT,
} = require('../src/config/operationContract')
const SqliteStore = require('../src/data/storage/SqliteStore')
const TrainingExporter = require('../src/data/exporters/TrainingExporter')
const TrainingRunner = require('../src/core/TrainingRunner')
const ModelRegistry = require('../src/core/ModelRegistry')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'appback-operation-'))
}

function runtime(operation = 'gc-v8-test', profile = 'sha256:profile-a', featureVersion = '8.0') {
  const featureDim = featureVersion === '8.0' ? 192 : 153
  return {
    schema_version: 1,
    operation_version: operation,
    feature_version: featureVersion,
    feature_dim: featureDim,
    feature_schema_id: `gc-${featureVersion}-test-${featureDim}`,
    feature_schema_hash: `sha256:schema-${featureVersion}`,
    training_version: 'v3-test',
    output_dim: 5,
    behavior_profile_id: 'navigator',
    behavior_profile_hash: profile,
    behavior_profile_revision: 2,
  }
}

test('operation activation blocks incompatible binary contracts until explicitly confirmed', () => {
  const dir = tempDir()
  const initial = new OperationVersionStore(dir)
  assert.equal(initial.ensureActive().operation_version, CURRENT_OPERATION_CONTRACT.operation_version)

  const nextContract = { ...CURRENT_OPERATION_CONTRACT, operation_version: 'gc-v8-test', feature_version: '8.0', feature_dim: 192 }
  const upgraded = new OperationVersionStore(dir, nextContract)
  assert.equal(upgraded.getStatus().compatible, false)
  assert.throws(() => upgraded.ensureActive(), /operation activate --yes/)
  assert.throws(() => upgraded.activate(), /requires --yes/)

  assert.equal(upgraded.activate({ allowChange: true }).operation_version, 'gc-v8-test')
  assert.equal(upgraded.listHistory()[0].operation_version, CURRENT_OPERATION_CONTRACT.operation_version)
})

test('operation store detects an explicitly activated supported v8 contract on restart', () => {
  const dir = tempDir()
  const v8Store = new OperationVersionStore(dir, V8_OPERATION_CONTRACT)
  const active = v8Store.activate({ allowChange: true })
  assert.equal(active.feature_dim, 192)

  const restarted = new OperationVersionStore(dir)
  const status = restarted.getStatus()
  assert.equal(status.binary.operation_version, 'gc-v8-r1')
  assert.equal(status.compatible, true)
  assert.equal(restarted.ensureActive().feature_schema_hash, V8_OPERATION_CONTRACT.feature_schema_hash)
})

test('operation CLI explicitly activates v8 without changing the default v7 contract', () => {
  const dir = tempDir()
  const cli = path.join(__dirname, '..', 'bin', 'cli.js')
  const activated = spawnSync(process.execPath, [cli, 'operation', 'activate', 'v8', '--yes'], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.equal(activated.status, 0, activated.stderr)
  assert.match(activated.stdout, /Active operation: gc-v8-r1/)
  assert.match(activated.stdout, /v8\.0 \/ 192 dimensions/)

  const shown = spawnSync(process.execPath, [cli, 'operation', 'show'], { cwd: dir, encoding: 'utf8' })
  assert.equal(shown.status, 0, shown.stderr)
  assert.match(shown.stdout, /Binary operation: gc-v8-r1/)
  assert.match(shown.stdout, /Status: compatible/)
})

test('operation CLI activates the isolated v8.1 strategy contract by explicit name', () => {
  const dir = tempDir()
  const cli = path.join(__dirname, '..', 'bin', 'cli.js')
  const activated = spawnSync(process.execPath, [cli, 'operation', 'activate', 'v81', '--yes'], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.equal(activated.status, 0, activated.stderr)
  assert.match(activated.stdout, /Active operation: gc-v8-strategy-r1/)
  assert.match(activated.stdout, /v8\.1 \/ 214 dimensions/)
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'operation.json'), 'utf8'))
  assert.equal(stored.feature_schema_hash, V81_OPERATION_CONTRACT.feature_schema_hash)
  assert.deepEqual(stored.strategy_labels, V81_OPERATION_CONTRACT.strategy_labels)
  assert.equal(new OperationVersionStore(path.join(dir, 'config')).getStatus().compatible, true)
})

test('session counts and exports exclude legacy and other-profile data', () => {
  const root = tempDir()
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir)

  const legacyStore = new SqliteStore(dataDir)
  const legacyId = legacyStore.startSession('claw-clash', 'legacy-game', 0)
  legacyStore.endSession(legacyId, { rank: 1, score: 100 }, [])
  legacyStore.close()

  const context = runtime('gc-v7-test', 'sha256:profile-a', '7.0')
  const store = new SqliteStore(dataDir, context)
  const currentId = store.startSession('claw-clash', 'current-game', 1)
  store.recordTick(currentId, 1, 0, {}, new Array(153).fill(0), { action: 'up' })
  store.endSession(currentId, { rank: 2, score: 80 }, [])

  assert.equal(store.getSessionCount('claw-clash'), 1)
  assert.equal(store.getCompletedSessions('claw-clash')[0].game_id, 'current-game')

  const exportDir = path.join(root, 'export')
  const result = new TrainingExporter(store, exportDir, context).exportForTraining('claw-clash', 1)
  assert.equal(result.sessionCount, 1)
  assert.equal(result.tickCount, 1)

  const sessions = JSON.parse(fs.readFileSync(result.sessionsPath, 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  assert.deepEqual(sessions.map(item => item.game_id), ['current-game'])
  assert.equal(manifest.operation_version, 'gc-v7-test')
  assert.equal(manifest.behavior_profile_hash, 'sha256:profile-a')

  const otherProfile = new SqliteStore(dataDir, runtime('gc-v7-test', 'sha256:profile-b', '7.0'))
  assert.equal(otherProfile.getSessionCount('claw-clash'), 0)
  otherProfile.close()
  store.close()
})

test('existing pre-version database rows migrate into the legacy scope', () => {
  const root = tempDir()
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir)
  const dbPath = path.join(dataDir, 'agent.db')
  const oldDb = new Database(dbPath)
  oldDb.exec(`
    CREATE TABLE game_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game TEXT NOT NULL,
      game_id TEXT NOT NULL,
      result TEXT
    );
    INSERT INTO game_sessions (game, game_id, result)
    VALUES ('claw-clash', 'old-game', '{"rank":1}');
  `)
  oldDb.close()

  const store = new SqliteStore(dataDir, runtime())
  const migrated = store.db.prepare('SELECT operation_version, feature_dim, behavior_profile_hash FROM game_sessions').get()
  assert.deepEqual(migrated, {
    operation_version: 'legacy-unversioned',
    feature_dim: 0,
    behavior_profile_hash: 'unknown',
  })
  assert.equal(store.getSessionCount('claw-clash'), 0)
  store.close()
})

test('model registry rejects ONNX metadata from another operation or profile', async () => {
  const root = tempDir()
  const modelDir = path.join(root, 'models')
  const generationDir = path.join(modelDir, 'gc', 'generations', 'gc-v8-test', 'profile-a')
  fs.mkdirSync(generationDir, { recursive: true })
  fs.writeFileSync(path.join(generationDir, 'gc_move_model.onnx'), 'not-loaded-before-contract-check')
  fs.writeFileSync(path.join(generationDir, 'meta.json'), JSON.stringify({
    operation_version: 'gc-v7-old',
    feature_version: '7.0',
    feature_schema_hash: 'sha256:old',
    training_version: 'v2',
    behavior_profile_hash: 'sha256:profile-a',
    input_dim: 153,
    output_dim: 5,
  }))

  const registry = new ModelRegistry(modelDir)
  await assert.rejects(
    registry.loadModel('gc', 'gc_move_model', {
      path: path.join('generations', 'gc-v8-test', 'profile-a', 'gc_move_model.onnx'),
      runtimeContext: runtime(),
    }),
    /Model contract mismatch/
  )
})

test('model registry accepts the GC upload feature_dim metadata field', () => {
  const root = tempDir()
  const modelPath = path.join(root, 'gc_strategy_model.onnx')
  fs.writeFileSync(modelPath, 'contract-check-only')
  const expected = runtime('gc-v8-strategy-r1', 'sha256:profile-a', '8.1')
  expected.feature_dim = 214
  expected.output_dim = 11
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({
    operation_version: expected.operation_version,
    feature_version: expected.feature_version,
    feature_schema_hash: expected.feature_schema_hash,
    training_version: expected.training_version,
    behavior_profile_hash: expected.behavior_profile_hash,
    feature_dim: 214,
    output_dim: 11,
  }))

  assert.doesNotThrow(() => new ModelRegistry(root)._validateContract(modelPath, expected))
})

test('training runner freezes the startup profile contract for an in-progress generation', () => {
  const root = tempDir()
  const outputDir = path.join(root, 'models')
  fs.mkdirSync(outputDir)
  fs.writeFileSync(path.join(outputDir, 'meta.json'), JSON.stringify({
    input_dim: 192,
    output_dim: 5,
  }))
  const startup = runtime('gc-v8-r1', 'sha256:profile-before', '8.0')
  const runner = new TrainingRunner({ outputDir, runtimeContext: startup })

  startup.behavior_profile_hash = 'sha256:profile-after'
  startup.behavior_profile_revision = 99
  runner._writeOperationMetadata()

  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'meta.json'), 'utf8'))
  assert.equal(metadata.behavior_profile_hash, 'sha256:profile-before')
  assert.equal(metadata.behavior_profile_revision, 2)
})
