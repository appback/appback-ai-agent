module.exports = {
  apiUrl: process.env.GC_API_URL || 'https://clash.appback.app/api/v1',
  wsUrl: process.env.GC_WS_URL || 'https://clash.appback.app',
  apiToken: process.env.GC_API_TOKEN || '',
  agentName: process.env.AGENT_NAME || '',
  discoveryIntervalSec: parseInt(process.env.GAME_DISCOVERY_INTERVAL_SEC || '30'),

  // Strategy timing
  strategyCooldownTicks: 10,
  maxStrategyChanges: 30,

  // Default loadout
  defaultWeapon: 'sword',
  defaultArmor: 'leather',
  defaultTier: 'basic',
}
