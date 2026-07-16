const fs = require('fs')
const path = require('path')
const { PRESETS } = require('../../src/config/personalityPresets')
const { compileProfile } = require('../../src/config/ProfileCompiler')
const { validateProfile } = require('../../src/config/ProfileValidator')
const {
  BehaviorProfileStore,
  createEasyProfile,
  expertTemplate,
  randomSeed,
  readJson,
  writeJsonAtomic,
} = require('../../src/config/BehaviorProfileStore')

function runPersonalityCommand(options = {}) {
  const args = options.args || []
  const cwd = options.cwd || process.cwd()
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  const out = line => stdout.write(`${line}\n`)
  const error = line => stderr.write(`${line}\n`)
  const store = new BehaviorProfileStore(path.join(cwd, 'config'))

  try {
    const command = args[0]

    if (!command || command === 'help' || command === '--help' || command === '-h') {
      out(helpText())
      return 0
    }
    if (command === 'list') return listPresets(out)
    if (command === 'show') return showCurrent(store, args, out)
    if (command === 'validate') return validateCurrent(store, out)
    if (command === 'set') return setEasy(store, args.slice(1), out)
    if (command === 'reroll') return reroll(store, out)
    if (command === 'reset') return reset(store, out)
    if (command === 'history') return showHistory(store, out)
    if (command === 'rollback') return rollback(store, args[1], out)
    if (command === 'export') return exportProfile(store, args.slice(1), cwd, out)
    if (command === 'diff') return diffProfile(store, args[1], cwd, out)
    if (command === 'expert') return runExpert(store, args.slice(1), cwd, out)

    throw new Error(`Unknown personality command: ${command}\n\n${helpText()}`)
  } catch (err) {
    error(`Error: ${err.message}`)
    return 1
  }
}

function listPresets(out) {
  out('Available personalities (Easy mode):')
  out('')
  for (const [id, preset] of Object.entries(PRESETS)) {
    out(`  ${id.padEnd(10)} ${preset.label.padEnd(5)} ${preset.description}`)
  }
  out('')
  out('Set one with: npx appback-ai-agent personality set <name>')
  return 0
}

function showCurrent(store, args, out) {
  const current = store.getCurrent()
  if (args.includes('--json')) {
    out(JSON.stringify({
      persisted: current.persisted,
      configured: current.configured,
      effective: current.effective,
      deployed: { status: 'unavailable', reason: 'GC behavior profile metadata is not implemented yet' },
    }, null, 2))
    return 0
  }

  const source = current.configured
  const effective = current.effective
  out(`Personality: ${effective.profile_id} (${effective.label})`)
  out(`Mode:        ${source.mode}`)
  out(`Revision:    ${effective.source_revision}${current.persisted ? '' : ' (default, not saved)'}`)
  if (source.mode === 'easy') {
    out(`Variation:   ${source.variation_percent}%`)
    out(`Seed:        ${source.seed}`)
  }
  out(`Profile hash: ${effective.profile_hash}`)
  out('Deployed:     unavailable until GC model metadata v8 is implemented')
  out('')
  out('Effective objective weights:')
  for (const [key, value] of Object.entries(effective.objective)) out(`  ${key.padEnd(16)} ${value}`)
  out('Effective policy:')
  for (const [key, value] of Object.entries(effective.policy)) out(`  ${key.padEnd(27)} ${value}`)
  out('Equipment preferences:')
  for (const [key, value] of Object.entries(effective.equipment)) out(`  ${key.padEnd(27)} ${value}`)
  return 0
}

function validateCurrent(store, out) {
  const current = store.getCurrent()
  const errors = validateProfile(current.configured)
  if (errors.length) throw new Error(errors.join('\n'))
  const compiled = compileProfile(current.configured)
  out(`Valid personality: ${compiled.profile_id}`)
  out(`Profile hash: ${compiled.profile_hash}`)
  return 0
}

function setEasy(store, args, out) {
  const preset = args[0]
  if (!preset || preset.startsWith('--')) throw new Error('Usage: personality set <preset> [--variation 0-15] [--seed number]')
  assertOptionSyntax(args.slice(1), { '--variation': true, '--seed': true })
  if (!Object.prototype.hasOwnProperty.call(PRESETS, preset)) {
    throw new Error(`Unknown preset: ${preset}. Use one of: ${Object.keys(PRESETS).join(', ')}`)
  }

  const variation = numberOption(args, '--variation', 8)
  const seed = numberOption(args, '--seed', randomSeed())
  const snapshot = store.save(createEasyProfile(preset, variation, seed))
  printSaved(snapshot, out)
  return 0
}

function reroll(store, out) {
  const current = store.getCurrent().configured
  if (current.mode !== 'easy') throw new Error('reroll is only available in Easy mode')
  const snapshot = store.save(createEasyProfile(current.preset, current.variation_percent, randomSeed()))
  printSaved(snapshot, out)
  return 0
}

function reset(store, out) {
  const snapshot = store.save(createEasyProfile('balanced', 8, randomSeed()))
  printSaved(snapshot, out)
  return 0
}

function showHistory(store, out) {
  const history = store.listHistory()
  if (!history.length) {
    out('No saved personality revisions')
    return 0
  }
  out('Personality history:')
  for (const item of history) {
    out(`  r${String(item.configured.revision).padEnd(4)} ${item.effective.mode.padEnd(6)} ${item.effective.profile_id.padEnd(20)} ${item.effective.profile_hash}`)
  }
  return 0
}

function rollback(store, value, out) {
  const revision = parseInteger(value, 'revision')
  const snapshot = store.rollback(revision)
  out(`Rolled back from revision ${revision} as new revision ${snapshot.configured.revision}`)
  printSaved(snapshot, out)
  return 0
}

function exportProfile(store, args, cwd, out) {
  const file = args[0]
  if (!file || file.startsWith('--')) throw new Error('Usage: personality export <file> [--force]')
  assertOptionSyntax(args.slice(1), { '--force': false })
  const destination = path.resolve(cwd, file)
  store.exportTo(destination, args.includes('--force'))
  out(`Exported personality to ${destination}`)
  return 0
}

function diffProfile(store, file, cwd, out) {
  if (!file) throw new Error('Usage: personality diff <file>')
  const candidate = readJson(path.resolve(cwd, file))
  const errors = validateProfile(candidate)
  if (errors.length) throw new Error(`Invalid comparison profile:\n- ${errors.join('\n- ')}`)
  const current = store.getCurrent().effective
  const compared = compileProfile(candidate)
  const differences = diffObjects(current, compared, '', ['source_revision', 'profile_hash'])

  if (!differences.length) {
    out('No effective behavior differences')
    return 0
  }
  out('Effective behavior differences:')
  for (const item of differences) out(`  ${item.path}: ${formatValue(item.left)} -> ${formatValue(item.right)}`)
  return 0
}

function runExpert(store, args, cwd, out) {
  const command = args[0]
  if (!command || command === 'help' || command === '--help') {
    out(expertHelpText())
    return 0
  }
  if (command === 'init') return expertInit(args.slice(1), cwd, out)
  if (command === 'validate') return expertValidate(args[1], cwd, out)
  if (command === 'apply') return expertApply(store, args[1], cwd, out)
  if (command === 'set') return expertSet(store, args[1], args[2], out)
  throw new Error(`Unknown expert command: ${command}\n\n${expertHelpText()}`)
}

function expertInit(args, cwd, out) {
  const file = args[0]
  if (!file || file.startsWith('--')) throw new Error('Usage: personality expert init <file> [--name name] [--force]')
  assertOptionSyntax(args.slice(1), { '--name': true, '--force': false })
  const destination = path.resolve(cwd, file)
  if (fs.existsSync(destination) && !args.includes('--force')) throw new Error(`File already exists: ${destination}`)
  const name = stringOption(args, '--name', 'custom')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  writeJsonAtomic(destination, expertTemplate(name))
  out(`Created Expert personality template: ${destination}`)
  return 0
}

function expertValidate(file, cwd, out) {
  if (!file) throw new Error('Usage: personality expert validate <file>')
  const profile = readJson(path.resolve(cwd, file))
  const errors = validateProfile(profile)
  if (errors.length) throw new Error(errors.join('\n'))
  const effective = compileProfile(profile)
  out(`Valid Expert personality: ${effective.profile_id}`)
  out(`Profile hash: ${effective.profile_hash}`)
  return 0
}

function expertApply(store, file, cwd, out) {
  if (!file) throw new Error('Usage: personality expert apply <file>')
  const profile = readJson(path.resolve(cwd, file))
  const snapshot = store.save(profile)
  printSaved(snapshot, out)
  return 0
}

function expertSet(store, field, rawValue, out) {
  if (!field || rawValue == null) throw new Error('Usage: personality expert set <field> <number>')
  const current = store.getCurrent().configured
  if (current.mode !== 'expert') throw new Error('Current personality is not Expert mode. Run personality expert apply <file> first.')
  if (!/^(objective|policy|equipment)\.[a-z_]+$/.test(field)) throw new Error(`Unsupported Expert field: ${field}`)
  const numericValue = Number(rawValue)
  if (!Number.isFinite(numericValue)) throw new Error(`Value must be a number: ${rawValue}`)

  const [group, key] = field.split('.')
  const updated = JSON.parse(JSON.stringify(current))
  delete updated.revision
  if (group === 'equipment' && !updated.equipment) {
    updated.equipment = JSON.parse(JSON.stringify(PRESETS.balanced.equipment))
  }
  updated[group][key] = numericValue
  const snapshot = store.save(updated)
  printSaved(snapshot, out)
  return 0
}

function printSaved(snapshot, out) {
  out(`Saved personality revision ${snapshot.configured.revision}`)
  out(`Profile: ${snapshot.effective.profile_id} (${snapshot.effective.label})`)
  out(`Hash:    ${snapshot.effective.profile_hash}`)
  out('The running agent, in-progress training, and deployed model are unchanged.')
  out('Restart the agent to apply the new teacher/export generation.')
  out('Strict same-profile collection starts after a matching model revision enters GC canary/active.')
}

function numberOption(args, name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (args[index + 1] == null) throw new Error(`${name} requires a number`)
  const value = Number(args[index + 1])
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

function stringOption(args, name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1]) throw new Error(`${name} requires a value`)
  return args[index + 1]
}

function assertOptionSyntax(args, definitions) {
  for (let i = 0; i < args.length; i++) {
    const option = args[i]
    if (!Object.prototype.hasOwnProperty.call(definitions, option)) throw new Error(`Unknown option: ${option}`)
    if (definitions[option]) {
      if (args[i + 1] == null || args[i + 1].startsWith('--')) throw new Error(`${option} requires a value`)
      i++
    }
  }
}

function parseInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function diffObjects(left, right, prefix, ignoredKeys) {
  const differences = []
  const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})])
  for (const key of [...keys].sort()) {
    if (ignoredKeys.includes(key)) continue
    const pathName = prefix ? `${prefix}.${key}` : key
    const leftValue = left?.[key]
    const rightValue = right?.[key]
    if (isObject(leftValue) && isObject(rightValue)) {
      differences.push(...diffObjects(leftValue, rightValue, pathName, ignoredKeys))
    } else if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
      differences.push({ path: pathName, left: leftValue, right: rightValue })
    }
  }
  return differences
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function formatValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function helpText() {
  return `Personality commands:
  personality list
  personality show [--json]
  personality validate
  personality set <preset> [--variation 0-15] [--seed number]
  personality reroll
  personality reset
  personality history
  personality rollback <revision>
  personality export <file> [--force]
  personality diff <file>
  personality expert <command>

Easy mode example:
  npx appback-ai-agent personality set hunter --variation 8 --seed 20260715

Expert mode help:
  npx appback-ai-agent personality expert help`
}

function expertHelpText() {
  return `Expert personality commands:
  personality expert init <file> [--name name] [--force]
  personality expert validate <file>
  personality expert apply <file>
  personality expert set <objective|policy|equipment.field> <number>`
}

module.exports = { runPersonalityCommand }
