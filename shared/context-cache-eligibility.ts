/** Vertex / Gemini Context Cache — tối thiểu token để tạo cachedContent (theo Google). */
export const GEMINI_CONTEXT_CACHE_MIN_TOKENS = 4096

/** Ước token cho systemInstruction (hơi cao để không gọi create khi chắc chắn < 4096). */
export function estimateContextCacheTokens(text: string): number {
  const t = text.trim()
  if (!t) return 0
  return Math.ceil(t.length / 3.2)
}

export function isContextCacheEligible(systemPrompt: string): boolean {
  return estimateContextCacheTokens(systemPrompt) >= GEMINI_CONTEXT_CACHE_MIN_TOKENS
}

export function isMinimumTokenCacheError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('minimum token count') ||
    m.includes('minimum token') ||
    (m.includes('4096') && m.includes('token')) ||
    m.includes('cached content is of')
  )
}
