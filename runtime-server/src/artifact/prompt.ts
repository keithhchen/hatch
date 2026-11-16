import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ArtifactConfig } from "./ports.js";

const read = (name: string) => readFile(fileURLToPath(new URL(`../../prompts/artifact/${name}`, import.meta.url)), "utf8");

const TOOLS = `# Report tools
- \`ls\` lists the client's files as /attachments/<name>, and /attachments/<name>.md for each file that has a text form.
- \`read(path, offset?, page?)\`: a .md path returns its text in pages. An original image is shown to you. An original PDF shows page \`page\` (default 1) as an image, with "page N of M". Any other original (docx, xlsx...) is read through its .md.
- \`grep\` searches the .md texts.
- \`publish_report(html)\` publishes the report once; it returns "Report published." or the exact errors to fix.`;

/** What an artifact conversation's agent is told beyond the Expert's own instructions: the shared report rules, the product's template, the tools. */
export async function artifactPrompt(config: ArtifactConfig): Promise<string> {
  return [await read("REPORT.md"), `# This product's report template\n\n${config.reportTemplate}`, TOOLS].join("\n\n");
}

/** What a new attempt is told: the form is already in the conversation, and so is whatever the earlier attempt did. */
export const ARTIFACT_RETRY_MESSAGE = "The earlier attempt ended before the report was published. Start again from the form above: read what you need and call publish_report.";
