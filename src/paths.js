const path = require('path')
const { profileSegment, safeSegment } = require('./config/operationContract')

const PKG_ROOT = process.env._PKG_ROOT || path.resolve(__dirname, '..')
const CWD = process.env._AGENT_CWD || process.cwd()

function resolve(envKey, fallback) {
  const raw = process.env[envKey] || fallback
  return path.isAbsolute(raw) ? raw : path.resolve(CWD, raw)
}

module.exports = {
  PKG_ROOT,
  CWD,
  modelDir: () => resolve('MODEL_DIR', 'models'),
  dataDir: () => resolve('DATA_DIR', 'data'),
  configDir: () => resolve('CONFIG_DIR', 'config'),
  trainingDataDir: (runtime = {}) => path.join(
    resolve('TRAINING_DATA_DIR', path.join('training', 'data')),
    safeSegment(runtime.operation_version),
    profileSegment(runtime.behavior_profile_hash)
  ),
  modelGenerationDir: (runtime = {}) => path.join(
    resolve('MODEL_DIR', 'models'),
    'gc',
    'generations',
    safeSegment(runtime.operation_version),
    profileSegment(runtime.behavior_profile_hash)
  ),
  trainingScript: () => path.join(PKG_ROOT, 'training', 'train_gc_model.py'),
  trainingRoot: () => path.join(PKG_ROOT, 'training'),
  gcV81BootstrapRoot: () => path.join(PKG_ROOT, 'bootstrap', 'gc-v8.1'),
}
