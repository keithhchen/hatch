import { voiceTtsUrl } from "./entitlement-client.js";

const MAX_CHUNK_CHARS = 400;

export async function synthesizeSpeech(runtimeUrl, accessToken, payload, fetchImpl = fetch) {
  const response = await fetchImpl(voiceTtsUrl(runtimeUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "audio/mpeg"
    },
    body: JSON.stringify({
      entitlement_id: payload.entitlementId,
      creator_id: payload.creatorId,
      agent_id: payload.agentId,
      text: payload.text,
      ...(payload.previousRequestIds.length > 0
        ? { previous_request_ids: payload.previousRequestIds }
        : {})
    })
  });
  if (!response.ok) {
    const payloadBody = await response.json().catch(() => ({}));
    throw new Error(payloadBody?.error?.message || `Voice synthesis failed with ${response.status}.`);
  }
  return {
    blob: await response.blob(),
    requestId: response.headers.get("x-request-id") || ""
  };
}

export function splitTextForSpeech(text) {
  const paragraphs = String(text ?? "")
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if ((current + "\n" + paragraph).length <= MAX_CHUNK_CHARS) {
      current = current ? `${current}\n${paragraph}` : paragraph;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length <= MAX_CHUNK_CHARS) {
      current = paragraph;
      continue;
    }
    let rest = paragraph;
    while (rest.length > MAX_CHUNK_CHARS) {
      const slice = rest.slice(0, MAX_CHUNK_CHARS);
      const lastSpace = slice.lastIndexOf(" ");
      const cut = lastSpace > MAX_CHUNK_CHARS * 0.5 ? lastSpace : MAX_CHUNK_CHARS;
      chunks.push(slice.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

export function voicePreferenceKey(profileId, entitlementId) {
  return `hatch.sound.${profileId}.${entitlementId}`;
}

export function loadVoicePreference(profileId, entitlementId, fallback = false) {
  try {
    const stored = localStorage.getItem(voicePreferenceKey(profileId, entitlementId));
    return stored === null ? fallback : stored === "on";
  } catch {
    return fallback;
  }
}

export function saveVoicePreference(profileId, entitlementId, enabled) {
  localStorage.setItem(voicePreferenceKey(profileId, entitlementId), enabled ? "on" : "off");
}
