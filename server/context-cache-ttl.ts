const TTL_MIN_S = 60
const TTL_MAX_S = 86_400

function clampTtlSeconds(n: number): number {
  return Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, Math.floor(n)))
}

/**
 * TTL Context Cache Gemini (giây).
 * - Nếu đặt `GEMINI_CONTEXT_CACHE_TTL_S` → dùng giá trị đó (kẹp 60s–24h).
 * - Nếu `GEMINI_CONTEXT_CACHE_COST_MODE=aggressive` → 10 phút (bớt phí storage khi thử nghiệm).
 * - `NODE_ENV !== 'production'` mặc định 15 phút (tránh treo cache lâu khi dev local).
 * - Production mặc định 1 giờ (cân bằng storage vs tần suất tạo lại cache).
 */
export function resolveGeminiContextCacheTtlSeconds(): number {
  const envRaw = process.env.GEMINI_CONTEXT_CACHE_TTL_S?.trim()
  if (envRaw) {
    const n = Number(envRaw)
    if (Number.isFinite(n) && n > 0) return clampTtlSeconds(n)
  }

  const mode = process.env.GEMINI_CONTEXT_CACHE_COST_MODE?.trim().toLowerCase()
  if (mode === 'aggressive' || mode === 'minimal' || mode === 'low') {
    return 600
  }

  if (process.env.NODE_ENV !== 'production') {
    return 900
  }

  return 3600
}
