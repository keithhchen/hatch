export function assistantAnimationChunkSize(pendingCharacters) {
  if (pendingCharacters > 1_500) return 64;
  if (pendingCharacters > 500) return 24;
  if (pendingCharacters > 120) return 8;
  return 4;
}

export function takeAssistantAnimationChunk(text) {
  const characters = Array.from(text);
  const chunkSize = assistantAnimationChunkSize(characters.length);
  return {
    chunk: characters.slice(0, chunkSize).join(""),
    remaining: characters.slice(chunkSize).join("")
  };
}
