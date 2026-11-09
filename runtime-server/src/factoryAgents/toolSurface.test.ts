import assert from "node:assert/strict";
import test from "node:test";
import { authorizeToolCall } from "../surfaces/contract.js";
import { studioToolSupport } from "./toolSurface.js";

test("askuser needs a structured answer form: Studio declares it unavailable on im and dm", () => {
  const askuser = { name: "askuser", description: "", supportedClients: studioToolSupport("askuser") };
  for (const client of ["web", "desktop", "cli", "mcp"] as const) assert.equal(authorizeToolCall(askuser, client).allowed, true, client);
  for (const client of ["im", "dm"] as const) assert.equal(authorizeToolCall(askuser, client).allowed, false, client);
});

test("a tool that is plain text in and out runs everywhere", () => {
  for (const name of ["list", "read", "grep", "write", "update_todo", "web_search"]) assert.equal(studioToolSupport(name), "*", name);
});
