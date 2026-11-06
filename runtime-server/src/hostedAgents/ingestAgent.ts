import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSpec, HostedSecret, SandboxSpec } from "./ports.js";

/** Everything the ingest sandbox needs, preinstalled in the image so a run starts ready. */
export const INGEST_SANDBOX: SandboxSpec = {
  name: "hatch-ingest",
  packages: {
    apt: ["xvfb", "xauth", "tesseract-ocr-chi-sim", "fonts-noto-cjk"],
    pip: ["playwright", "websocket-client"],
    npm: ["@browsermcp/mcp"],
  },
  setupScript: "python3 -m playwright install --with-deps chromium",
  networking: { type: "unrestricted" },
};

const SKILLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../hosted-skills");

export const ingestAgent = (model: string): AgentSpec => ({
  name: "hatch-ingest",
  model,
  system: [
    "You turn links and files into Hatch source material: for every item, the original and a faithful Markdown version.",
    "Work through the hatch-ingest skill. Run its scripts for real; never invent content, metadata or results.",
    "Never print, log or echo environment variable values. Never try to log in to any site.",
    "When an item fails, record why in result.json and continue with the rest.",
  ].join("\n"),
  skills: [{ name: "hatch-ingest", dir: path.join(SKILLS_ROOT, "hatch-ingest") }],
});

/** Platform-wide secrets every ingest run carries, each reachable only from its own hosts. */
export const ingestSecrets = (environment: NodeJS.ProcessEnv): HostedSecret[] =>
  environment.DASHSCOPE_API_KEY?.trim()
    ? [{ name: "DASHSCOPE_API_KEY", value: environment.DASHSCOPE_API_KEY.trim(), hosts: ["dashscope.aliyuncs.com"] }]
    : [];
