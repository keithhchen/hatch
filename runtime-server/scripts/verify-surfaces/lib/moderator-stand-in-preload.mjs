// VERIFICATION TOOL ONLY. Two FAKES, labelled wherever they are used. The shipped Chat Runtime cannot take a file or show the model its
// file tools, so nothing behind those two gaps could be exercised. This preload (node --import) closes only them:
//  1. the content moderator that refuses every upload (src/chat/openChatAssets.ts never configures one) says "allowed";
//  2. the model declaration filter lets the attachments.* tools through (see stand-in-loader.mjs).
// Records, object storage, sniffing, text extraction, ls/grep/read, scoping, dispatch and the model are all the product's own.
import { register } from "node:module";
register(new URL("./stand-in-loader.mjs", import.meta.url));
const { UnavailableModerator } = await import(new URL("../../../dist/conversations/pipelineAssets.js", import.meta.url).href);
UnavailableModerator.prototype.check = async () => ({ allowed: true });
