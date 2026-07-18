export function createSocketLifecycleState() {
  return { socket: null, generation: 0 };
}

export function registerSocket(state, socket) {
  state.generation += 1;
  state.socket = socket;
  return state.generation;
}

export function isCurrentSocket(state, socket, generation) {
  return state.socket === socket && state.generation === generation;
}

export function handleCurrentSocketClose(state, socket, generation, onClose) {
  if (!isCurrentSocket(state, socket, generation)) return false;
  state.socket = null;
  state.generation += 1;
  onClose();
  return true;
}

export function invalidateSocket(state, socket) {
  if (socket && state.socket !== socket) return false;
  state.socket = null;
  state.generation += 1;
  return true;
}
