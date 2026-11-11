import { fitImagesToBudget } from "../assets/views.js";
import type { ConversationMessage } from "../protocol.js";

/** Pixels the model is shown across a conversation. Older images beyond it are dropped; their path labels stay in the text. */
export const MODEL_IMAGE_BUDGET_BYTES = 8 * 1024 * 1024;

const LABELS = /\[image: [^\]]+\]/g;

/** Only an image that has its label in the text can be dropped, because the label is what replaces it. */
const droppable = (message: ConversationMessage): boolean =>
  Boolean(message.model_images?.length) && (message.content?.match(LABELS)?.length ?? 0) === message.model_images!.length;

/** The history as the model reads it: oldest images dropped first until the rest fit. The stored messages are not touched. */
export function withinImageBudget(messages: ConversationMessage[], budgetBytes = MODEL_IMAGE_BUDGET_BYTES): ConversationMessage[] {
  const slots = messages.flatMap((message, index) => droppable(message)
    ? message.model_images!.map((image, at) => ({ id: `${index}:${at}`, bytes: Math.floor(image.data.length * 3 / 4), label: "" }))
    : []);
  const dropped = new Set(fitImagesToBudget(slots, budgetBytes).filter((slot) => !slot.kept).map((slot) => slot.id));
  if (!dropped.size) return messages;
  return messages.map((message, index) => droppable(message)
    ? { ...message, model_images: message.model_images!.filter((_, at) => !dropped.has(`${index}:${at}`)) }
    : message);
}
