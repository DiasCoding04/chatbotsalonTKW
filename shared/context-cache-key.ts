export function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** Khóa cache dùng chung — chỉ phụ thuộc model + systemPrompt. */
export function buildContextCacheFingerprint(model: string, systemPrompt: string): string {
  return fnv1aHash(`${model}\n${systemPrompt.trim()}`)
}
