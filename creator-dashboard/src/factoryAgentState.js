export function agentDependencyGaps(agent) {
  if (!agent) return { required: [], alternatives: [] };
  return {
    required: unique(agent.availability?.missingRequired),
    alternatives: agent.availability?.normal?.required && !agent.availability.normal.satisfied
      ? unique(agent.dependencies?.normal)
      : []
  };
}

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

export function localizeAgentText(value, locale = 'en') {
  return value?.[locale] ?? value?.en ?? '';
}

function unique(values) { return [...new Set(Array.isArray(values) ? values : [])]; }
