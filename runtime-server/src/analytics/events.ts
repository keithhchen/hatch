import type { AnalyticsEvent } from "./port.js";

/** The event catalog of Runtime and Registry: the one place names and property shapes are written. */
export type Surface = "studio" | "chat";
export type ChatChannel = "web" | "api" | "im";

export const agentCreated = (agentId: string): AnalyticsEvent => ["agent_created", { agent_id: agentId }];
export const materialUploaded = (agentId: string, kind: "file" | "link", count: number): AnalyticsEvent => ["material_uploaded", { agent_id: agentId, kind, count }];
export const reviewPageOpened = (agentId: string, formId: string, submitted: boolean): AnalyticsEvent => ["review_page_opened", { agent_id: agentId, form_id: formId, submitted }];
export const reviewPageSubmitted = (agentId: string, formId: string, questions: number, answered: number): AnalyticsEvent => ["review_page_submitted", { agent_id: agentId, form_id: formId, questions, answered }];
export const buildStarted = (agentId: string): AnalyticsEvent => ["build_started", { agent_id: agentId }];
export const buildCompleted = (agentId: string, durationS: number): AnalyticsEvent => ["build_completed", { agent_id: agentId, duration_s: durationS }];
export const buildFailed = (agentId: string, durationS: number, reason: string): AnalyticsEvent => ["build_failed", { agent_id: agentId, duration_s: durationS, reason }];
export const agentPublished = (agentId: string): AnalyticsEvent => ["agent_published", { agent_id: agentId }];
export const agentUnpublished = (agentId: string): AnalyticsEvent => ["agent_unpublished", { agent_id: agentId }];
export const studioMessageSent = (agentId: string, step: string): AnalyticsEvent => ["studio_message_sent", { agent_id: agentId, step }];
export const assistantMessageSent = (channel: string): AnalyticsEvent => ["assistant_message_sent", { channel }];
export const firstMessageSent = (agentId: string, channel: ChatChannel): AnalyticsEvent => ["first_message_sent", { agent_id: agentId, channel }];
export const messageSent = (agentId: string, channel: ChatChannel, n: number): AnalyticsEvent => ["message_sent", { agent_id: agentId, channel, n }];
export const replyFailed = (agentId: string, channel: ChatChannel, reason: string): AnalyticsEvent => ["reply_failed", { agent_id: agentId, channel, reason }];
export const reportReady = (durationS: number): AnalyticsEvent => ["report_ready", { duration_s: durationS }];
export const reportFailed = (reason: string): AnalyticsEvent => ["report_failed", { reason }];
export const usageCapReached = (surface: Surface): AnalyticsEvent => ["usage_cap_reached", { surface }];

/** An event of someone with no account (an IM contact): counted, but given no person profile. */
export const anonymous = ([event, props]: AnalyticsEvent): AnalyticsEvent => [event, { ...props, $process_person_profile: false }];

/** The Studio step a workspace role belongs to. */
export const STUDIO_STEPS: Record<string, string> = { research: "upload", voice: "interview", generation: "build", inspiration: "inspiration", "content-creation": "content" };
export const studioStep = (role: string): string => STUDIO_STEPS[role] ?? role;
