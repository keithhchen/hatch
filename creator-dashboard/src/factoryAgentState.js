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

// This is deliberately derived from the two output timestamps already in the
// Factory snapshot. It is not persisted as another piece of dependency state.
export function changedDependencies(agent, agents = []) {
  if (!agent?.outputUpdatedAt) return [];
  const byRole = new Map(agents.map(candidate => [candidate.role, candidate]));
  const roles = [...(agent.dependencies?.required || []), ...(agent.dependencies?.normal || []), ...(agent.dependencies?.updates || [])];
  return unique(roles).filter(role => {
    const dependency = byRole.get(role);
    return Boolean(dependency?.outputUpdatedAt && dependency.outputUpdatedAt > agent.outputUpdatedAt);
  });
}

export function localizeAgentText(value, locale = 'en') {
  return value?.[locale] ?? value?.en ?? '';
}

function unique(values) { return [...new Set(Array.isArray(values) ? values : [])]; }
