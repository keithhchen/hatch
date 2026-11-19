import { createPiModels } from "../piModel.js";
import type { ModelRoleResolver } from "../modelRoles.js";
import type { TitleModel } from "./conversationTitles.js";

/** Room for a reasoning model's thinking and then a short title. */
const TITLE_MAX_TOKENS = 2_048;

/** The title model in production: one completion on whichever profile the `title` role names now. */
export const roleTitleModel = (models: ModelRoleResolver, env: NodeJS.ProcessEnv = process.env): TitleModel => async ({ system, user, signal }) => {
  const profile = await models.resolve("title");
  const { models: registry, model } = createPiModels({ profile, env });
  const reply = await registry.completeSimple(model, { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] }, { signal, maxTokens: TITLE_MAX_TOKENS });
  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? `The title model stopped: ${reply.stopReason}`);
  return reply.content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
};
