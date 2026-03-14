/**
 * Game states where the agent should stop waiting and clean up.
 * - ended: normal game completion
 * - archived: game data archived / cancelled due to insufficient entries
 * - cancelled: game terminated (e.g., server restart stale games)
 */
const INACTIVE_STATES = ['ended', 'archived', 'cancelled']

module.exports = { INACTIVE_STATES }
