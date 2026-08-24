import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Local commands may start from runtime-server/, while production receives
// the same variables from Compose. Resolve the one repository-level .env
// without ever falling back to runtime-server/.env.
const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryEnvPath = path.resolve(packageDirectory, "..", ".env");
const configuredEnvPath = process.env.DOTENV_CONFIG_PATH?.trim();
const envPath = configuredEnvPath
  ? path.resolve(process.cwd(), configuredEnvPath)
  : repositoryEnvPath;

dotenv.config({ path: envPath });
