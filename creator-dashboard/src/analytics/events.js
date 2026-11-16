// The browser event catalog: the only place event names and property shapes are written.
// Each function returns an AnalyticsEvent tuple for Analytics.track.
export const signupStarted = ({ method }) => ["signup_started", { method }];
// The rail's step ids, named as the server's events name them, so browser and server steps line up.
const STEP_NAMES = { ask: "interview", ship: "publish" };
export const studioStepOpened = ({ agentId, step }) => ["studio_step_opened", { agent_id: agentId, step: STEP_NAMES[step] ?? step }];
export const videoPlayed = ({ videoId, positionS, durationS }) => ["video_played", { video_id: videoId, position_s: positionS, duration_s: durationS }];
export const videoProgress = ({ videoId, percent }) => ["video_progress", { video_id: videoId, percent }];
export const videoCompleted = ({ videoId, durationS }) => ["video_completed", { video_id: videoId, duration_s: durationS }];
export const reviewPageOpened = ({ formId }) => ["review_page_opened", { form_id: formId }];
export const askuserAnswered = ({ questions, skipped }) => ["askuser_answered", { questions, skipped }];
export const shareLinkCopied = ({ agentId, link }) => ["share_link_copied", { agent_id: agentId, link }];
export const ownAgentOpened = ({ agentId }) => ["own_agent_opened", { agent_id: agentId }];
export const errorShown = ({ area, category }) => ["error_shown", { area, category }];
export const agentPageViewed = ({ agentId, via }) => ["agent_page_viewed", { agent_id: agentId, via }];
export const chatStarted = ({ agentId }) => ["chat_started", { agent_id: agentId }];
export const intakeStarted = ({ agentId }) => ["intake_started", { agent_id: agentId }];
export const intakeSubmitted = ({ agentId, answered, files }) => ["intake_submitted", { agent_id: agentId, answered, files }];
export const reportViewed = ({ agentId, status, unlocked }) => ["report_viewed", { agent_id: agentId, status, unlocked }];
export const reportFileOpened = ({ agentId, name }) => ["report_file_opened", { agent_id: agentId, name }];

/** How a buyer reached an Agent page, from the referrer: nothing is direct, our catalog is catalog, anything else is a share. */
export function viaFromReferrer(referrer, origin) {
  if (!referrer) return "direct";
  if (!referrer.startsWith(origin)) return "share";
  return new URL(referrer).pathname.startsWith("/explore") ? "catalog" : "direct";
}
