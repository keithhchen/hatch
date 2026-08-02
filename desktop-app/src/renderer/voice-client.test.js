import { describe, expect, it, vi } from "vitest";
import { splitTextForSpeech, synthesizeSpeech, voicePreferenceKey } from "./voice-client.js";

describe("creator voice playback client", () => {
  it("splits long replies into bounded chunks without splitting sentences", () => {
    const short = "Short reply.";
    expect(splitTextForSpeech(short)).toEqual(["Short reply."]);

    const paragraph = "One sentence here. Another sentence here, still in the same paragraph.";
    expect(splitTextForSpeech(paragraph)).toEqual([paragraph]);

    const long = `${"A".repeat(150)}\n${"B".repeat(150)}\n${"C".repeat(150)}`;
    const chunks = splitTextForSpeech(long);
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.length <= 400)).toBe(true);
    expect(chunks.join(" ").replace(/\s/g, "")).toBe(long.replace(/\s/g, ""));

    const oversized = "X".repeat(900);
    const oversizeChunks = splitTextForSpeech(oversized);
    expect(oversizeChunks.every((chunk) => chunk.length <= 400)).toBe(true);
    expect(oversizeChunks.join("")).toBe(oversized);
  });

  it("posts chunk text with chunk continuity ids and returns audio", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "req_abc" },
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" })
    }));
    const result = await synthesizeSpeech(
      "https://runtime.example",
      "signed-token",
      { entitlementId: "ent_1", creatorId: "maya", agentId: "signal", text: "你好", previousRequestIds: ["req_1"] },
      fetchImpl
    );
    expect(result.requestId).toBe("req_abc");
    expect(fetchImpl).toHaveBeenCalledWith("https://runtime.example/v1/tts", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer signed-token" }),
      body: JSON.stringify({
        entitlement_id: "ent_1",
        creator_id: "maya",
        agent_id: "signal",
        text: "你好",
        previous_request_ids: ["req_1"]
      })
    }));
  });

  it("omits previous_request_ids for the first chunk and maps voice preference storage", () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "" },
      blob: async () => new Blob([], { type: "audio/mpeg" })
    }));
    return synthesizeSpeech("https://runtime.example", "t", {
      entitlementId: "e", creatorId: "c", agentId: "a", text: "x", previousRequestIds: []
    }, fetchImpl).then(() => {
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body.previous_request_ids).toBeUndefined();
    });
  });

  it("keys sound preference by profile and entitlement", () => {
    expect(voicePreferenceKey("buyer-1", "ent_signal")).toBe("hatch.sound.buyer-1.ent_signal");
  });
});
