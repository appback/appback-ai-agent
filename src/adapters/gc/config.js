const agentJwt = process.env.AI_REWARDS_AGENT_JWT || process.env.GC_API_TOKEN || ''

module.exports = {
  apiUrl: process.env.GC_API_URL || 'https://gc-v2-api.appback.app/api/v1',
  wsUrl: process.env.GC_WS_URL || 'https://gc-v2-api.appback.app',
  aiRewardsApiUrl: process.env.AI_REWARDS_API_URL || 'https://appback.app/api/v1',
  agentName: process.env.AI_AGENT_NAME || 'appback-ai-agent',
  agentJwt,
  // One-release deprecated alias. GcAdapter accepts it only when it is an AI Rewards JWT.
  apiToken: agentJwt,
  credentialSource: process.env.AI_REWARDS_AGENT_JWT
    ? 'AI_REWARDS_AGENT_JWT'
    : process.env.GC_API_TOKEN
      ? 'GC_API_TOKEN'
      : null,
  discoveryIntervalSec: parseInt(process.env.GAME_DISCOVERY_INTERVAL_SEC || '60'),
  queuePollIntervalSec: parseInt(process.env.GC_QUEUE_POLL_INTERVAL_SEC || '30'),

  // Strategy timing
  strategyCooldownTicks: 10,
  maxStrategyChanges: 30,

  // Default loadout
  defaultWeapon: 'sword',
  defaultArmor: 'leather',
  defaultTier: 'basic',
}
