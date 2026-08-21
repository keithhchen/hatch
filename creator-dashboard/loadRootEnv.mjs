import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Local Dashboard commands run from creator-dashboard/, while production
// receives the same values from Compose. Keep the repository root as the one
// local environment-file authority and never look for creator-dashboard/.env.
const dashboardDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryEnvPath = path.resolve(dashboardDirectory, "..", ".env");
if (existsSync(repositoryEnvPath)) process.loadEnvFile(repositoryEnvPath);
