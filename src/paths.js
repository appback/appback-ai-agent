const path = require('path')

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
  trainingDataDir: () => path.join(PKG_ROOT, 'training', 'data', 'raw'),
  trainingScript: () => path.join(PKG_ROOT, 'training', 'train_gc_model.py'),
  trainingRoot: () => path.join(PKG_ROOT, 'training'),
}
