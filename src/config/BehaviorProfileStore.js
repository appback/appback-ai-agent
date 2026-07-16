const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { compileProfile } = require('./ProfileCompiler')
const { assertValidProfile } = require('./ProfileValidator')

class BehaviorProfileStore {
  constructor(configDir) {
    this.configDir = configDir
    this.profilePath = path.join(configDir, 'personality.json')
    this.effectivePath = path.join(configDir, 'personality.effective.json')
    this.historyDir = path.join(configDir, 'personality.history')
  }

  getCurrent() {
    if (!fs.existsSync(this.profilePath)) {
      const configured = defaultProfile()
      return { configured, effective: withRevision(compileProfile(configured), 0), persisted: false }
    }

    const configured = readJson(this.profilePath)
    assertValidProfile(configured)
    const expected = withRevision(compileProfile(configured), configured.revision || 0)
    let effective = expected

    if (fs.existsSync(this.effectivePath)) {
      const stored = readJson(this.effectivePath)
      if (stored.profile_hash === expected.profile_hash && stored.source_revision === expected.source_revision) {
        effective = stored
      }
    }

    return { configured, effective, persisted: true }
  }

  save(profile) {
    const currentRevision = this._currentRevision()
    const configured = { ...profile, revision: currentRevision + 1 }
    assertValidProfile(configured)
    const effective = withRevision(compileProfile(configured), configured.revision)
    const snapshot = { configured, effective }

    fs.mkdirSync(this.historyDir, { recursive: true })
    writeJsonAtomic(this._historyPath(configured.revision), snapshot)
    writeJsonAtomic(this.effectivePath, effective)
    writeJsonAtomic(this.profilePath, configured)

    return snapshot
  }

  listHistory() {
    if (!fs.existsSync(this.historyDir)) return []
    return fs.readdirSync(this.historyDir)
      .filter(name => /^revision-\d+\.json$/.test(name))
      .map(name => readJson(path.join(this.historyDir, name)))
      .sort((a, b) => b.configured.revision - a.configured.revision)
  }

  rollback(revision) {
    const snapshotPath = this._historyPath(revision)
    if (!fs.existsSync(snapshotPath)) throw new Error(`Personality revision ${revision} not found`)
    const snapshot = readJson(snapshotPath)
    const configured = { ...snapshot.configured }
    delete configured.revision
    return this.save(configured)
  }

  exportTo(destination, overwrite = false) {
    if (fs.existsSync(destination) && !overwrite) throw new Error(`File already exists: ${destination}`)
    const { configured } = this.getCurrent()
    const exported = { ...configured }
    delete exported.revision
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    writeJsonAtomic(destination, exported)
    return destination
  }

  _currentRevision() {
    if (!fs.existsSync(this.profilePath)) return 0
    const current = readJson(this.profilePath)
    return Number.isInteger(current.revision) ? current.revision : 0
  }

  _historyPath(revision) {
    return path.join(this.historyDir, `revision-${String(revision).padStart(4, '0')}.json`)
  }
}

function defaultProfile(seed = 0) {
  return {
    schema_version: 1,
    mode: 'easy',
    preset: 'balanced',
    variation_percent: 0,
    seed,
  }
}

function createEasyProfile(preset, variationPercent = 8, seed = randomSeed()) {
  return {
    schema_version: 1,
    mode: 'easy',
    preset,
    variation_percent: variationPercent,
    seed,
  }
}

function expertTemplate(name = 'custom') {
  const balanced = compileProfile(defaultProfile())
  return {
    schema_version: 1,
    mode: 'expert',
    name,
    objective: balanced.objective,
    policy: balanced.policy,
    equipment: balanced.equipment,
  }
}

function randomSeed() {
  return crypto.randomBytes(4).readUInt32BE(0)
}

function withRevision(effective, revision) {
  return { ...effective, source_revision: revision }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    throw new Error(`Failed to read JSON ${filePath}: ${err.message}`)
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tempPath, filePath)
}

module.exports = {
  BehaviorProfileStore,
  createEasyProfile,
  defaultProfile,
  expertTemplate,
  randomSeed,
  readJson,
  writeJsonAtomic,
}
