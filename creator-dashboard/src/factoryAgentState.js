/** Build waits for one of these; each is a Factory page, not an Agent that must finish. */
export const BUILD_NEEDS = Object.freeze(["uploads", "voice"]);

export function agentStateKey(agent) {
  if (!agent) return 'loadingAgentState';
  return {
    locked: 'agentNeedsPreparation',
    ready: 'agentReady',
    running: 'agentRunning',
    complete: 'agentComplete',
    update_available: 'agentHasUpdates',
    failed: 'agentNeedsAttention'
  }[agent.state] ?? 'loadingAgentState';
}

/** Build is the only Agent that goes stale, and only when the interview has changed since it ran. */
export function updatedSources(agent) {
  return agent?.state === 'update_available' ? ['voice'] : [];
}

export function localizeAgentText(value, locale = 'en') {
  return value?.[locale] ?? value?.en ?? '';
}
