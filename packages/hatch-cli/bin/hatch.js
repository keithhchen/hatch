#!/usr/bin/env node
import { main } from "../src/cli.js";
import { realDeps } from "../src/context.js";

process.exitCode = await main(process.argv.slice(2), realDeps());
