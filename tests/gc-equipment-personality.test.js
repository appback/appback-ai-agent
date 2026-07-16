const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const GcEquipmentManager = require('../src/adapters/gc/GcEquipmentManager')
const SqliteStore = require('../src/data/storage/SqliteStore')
const { compileProfile } = require('../src/config/ProfileCompiler')
const { createEasyProfile, expertTemplate } = require('../src/config/BehaviorProfileStore')

const CATALOG = {
  weapons: [
    weapon('bow', 7, 10, 2, 90, ['light', 'cloth', 'none']),
    weapon('dagger', 6, 8, 1, 110, ['light', 'cloth', 'none'], {
      chance: 0.1, effect: 'triple_strike', trigger: 'chance',
    }),
    weapon('fists', 6, 8, 1, 100, ['none']),
    weapon('hammer', 9, 18, 1, 80, ['heavy', 'light', 'cloth', 'none'], {
      chance: 0.1, effect: 'aoe', trigger: 'chance', value: 10,
    }),
    weapon('spear', 8, 12, 2, 80, ['heavy', 'light', 'cloth', 'none'], {
      chance: 0.1, effect: 'heal', trigger: 'chance', value: 10,
    }),
    weapon('sword', 8, 10, 1, 100, ['heavy', 'light', 'cloth', 'none'], {
      chance: 0.1, effect: 'critical', trigger: 'chance', value: 15,
    }),
  ],
  armors: [
    armor('cloth_cape', 'cloth', 0, 0.1, 5),
    armor('iron_plate', 'heavy', 2, 0, -5),
    armor('leather', 'light', 1, 0.05, 0),
    armor('no_armor', 'none', 0, 0, 0),
  ],
}

test('Easy personalities select distinct deterministic initial loadouts', () => {
  const selections = {
    balanced: selectEasy('balanced'),
    hunter: selectEasy('hunter'),
    survivor: selectEasy('survivor'),
    collector: selectEasy('collector'),
    navigator: selectEasy('navigator'),
  }
  assert.deepEqual(selections.balanced, loadout('spear', 'cloth_cape'))
  assert.deepEqual(selections.hunter, loadout('hammer', 'cloth_cape'))
  assert.deepEqual(selections.survivor, loadout('spear', 'iron_plate'))
  assert.deepEqual(selections.collector, loadout('dagger', 'cloth_cape'))
  assert.deepEqual(selections.navigator, loadout('bow', 'cloth_cape'))
  assert.equal(new Set(Object.values(selections).map(value => `${value.weapon}:${value.armor}`)).size, 5)
  assert.deepEqual(selectEasy('hunter'), selectEasy('hunter'))
})

test('Expert equipment weights directly control speed and defense preferences', () => {
  const fast = expertWithEquipment({ speed: 2 })
  const defensive = expertWithEquipment({ defense: 2 })
  assert.deepEqual(select(fast), loadout('dagger', 'cloth_cape'))
  assert.deepEqual(select(defensive), loadout('hammer', 'iron_plate'))
})

test('profile-scoped history can override a neutral equipment prior', () => {
  const profile = expertWithEquipment({ history: 2 })
  const manager = new GcEquipmentManager(null, profile)
  manager.setCatalog(CATALOG)
  for (let i = 0; i < 5; i++) manager.recordResult('sword', 'iron_plate', { rank: 1, score: 100 })
  assert.deepEqual(manager.selectLoadout(), loadout('sword', 'iron_plate'))
})

test('equipment preferences participate in Easy variation and profile hashing', () => {
  const base = compileProfile(createEasyProfile('navigator', 0, 10))
  const varied = compileProfile(createEasyProfile('navigator', 15, 10))
  assert.notDeepEqual(base.equipment, varied.equipment)
  assert.notEqual(base.profile_hash, varied.profile_hash)
})

test('loadout results persist across restarts and remain profile-scoped', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appback-equipment-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const profile = expertWithEquipment({ history: 2 })
  const context = runtimeContext(profile.profile_hash)
  const store = new SqliteStore(dataDir, context)
  for (let i = 0; i < 5; i++) {
    store.saveLoadoutResult(`game-${i}`, 'sword', 'iron_plate', { rank: 1, score: 100 })
  }
  store.close()

  const restartedStore = new SqliteStore(dataDir, context)
  const restarted = new GcEquipmentManager(restartedStore, profile)
  restarted.setCatalog(CATALOG)
  restarted.loadStats()
  assert.deepEqual(restarted.selectLoadout(), loadout('sword', 'iron_plate'))
  assert.equal(restartedStore.getLoadoutResults().length, 5)
  restartedStore.close()

  const otherStore = new SqliteStore(dataDir, runtimeContext('sha256:other-profile'))
  assert.equal(otherStore.getLoadoutResults().length, 0)
  otherStore.close()
})

function selectEasy(preset) {
  return select(compileProfile(createEasyProfile(preset, 0, 1)))
}

function select(profile) {
  const manager = new GcEquipmentManager(null, profile)
  manager.setCatalog(CATALOG)
  return manager.selectLoadout()
}

function expertWithEquipment(overrides) {
  const source = expertTemplate('equipment-test')
  for (const key of Object.keys(source.equipment)) source.equipment[key] = 0
  Object.assign(source.equipment, overrides)
  return compileProfile(source)
}

function weapon(slug, damageMin, damageMax, range, speed, allowedArmors, skill = null) {
  return {
    slug,
    damage_min: damageMin,
    damage_max: damageMax,
    range,
    speed,
    allowed_armors: allowedArmors,
    skill,
  }
}

function armor(slug, category, reduction, evasion, speedMod) {
  return {
    slug,
    category,
    dmg_reduction: reduction,
    evasion,
    speed_mod: speedMod,
  }
}

function loadout(weaponSlug, armorSlug) {
  return { weapon: weaponSlug, armor: armorSlug, tier: 'basic' }
}

function runtimeContext(profileHash) {
  return {
    operation_version: 'gc-v8-r1',
    feature_version: '8.0',
    feature_dim: 192,
    feature_schema_hash: 'sha256:test-schema',
    training_version: 'teacher-v8-r1',
    behavior_profile_id: 'equipment-test',
    behavior_profile_hash: profileHash,
  }
}
