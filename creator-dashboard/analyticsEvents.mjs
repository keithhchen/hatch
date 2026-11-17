// The Dashboard server's product-analytics catalog: the only place event names and property shapes are written.
// Each function returns { event, properties }; ids and small enums only, never personal data.
export const signupCompleted = method => ({ event: "signup_completed", properties: { method } });
export const signedIn = method => ({ event: "signed_in", properties: { method } });
export const agentSaved = agentId => ({ event: "agent_saved", properties: { agent_id: agentId } });
export const agentRemoved = agentId => ({ event: "agent_removed", properties: { agent_id: agentId } });
