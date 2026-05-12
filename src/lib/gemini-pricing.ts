/**
 * Gemini Developer API — tier Standard (text), USD / 1M token.
 * Nguồn: https://ai.google.dev/gemini-api/docs/pricing
 * Cập nhật tay khi Google đổi giá; free tier thực tế = 0 USD.
 */
export type Tariff = {
  label: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
}

const TARIFFS: Record<string, Tariff> = {
  'gemini-2.5-flash': {
    label: 'Gemini 2.5 Flash',
    inputPerM: 0.3,
    outputPerM: 2.5,
    cacheReadPerM: 0.03,
  },
  'gemini-3.1-flash-lite': {
    label: 'Gemini 3.1 Flash-Lite',
    inputPerM: 0.25,
    outputPerM: 1.5,
    cacheReadPerM: 0.025,
  },
  'gemini-3.1-flash-lite-preview': {
    label: 'Gemini 3.1 Flash-Lite Preview',
    inputPerM: 0.25,
    outputPerM: 1.5,
    cacheReadPerM: 0.025,
  },
  'gemini-3-flash-preview': {
    label: 'Gemini 3 Flash Preview',
    inputPerM: 0.5,
    outputPerM: 3.0,
    cacheReadPerM: 0.05,
  },
  'gemini-2.0-flash-lite': {
    label: 'Gemini 2.0 Flash-Lite',
    inputPerM: 0.075,
    outputPerM: 0.3,
    cacheReadPerM: 0.01,
  },
  'gpt-4o-mini': {
    label: 'GPT-4o mini',
    inputPerM: 0.15,
    outputPerM: 0.6,
    cacheReadPerM: 0.075,
  },
}

export function getTariff(model: string): Tariff | null {
  if (TARIFFS[model]) return TARIFFS[model]
  const m = model.toLowerCase()
  if (m.includes('3.1') && m.includes('flash') && m.includes('lite')) return TARIFFS['gemini-3.1-flash-lite']
  if (m.includes('2.5') && m.includes('flash')) return TARIFFS['gemini-2.5-flash']
  if (m.includes('3') && m.includes('flash') && m.includes('preview')) return TARIFFS['gemini-3-flash-preview']
  if (m.includes('flash-latest')) return TARIFFS['gemini-2.5-flash']
  if (m.includes('2.0') && m.includes('lite')) return TARIFFS['gemini-2.0-flash-lite']
  if (m.includes('gpt-4o-mini')) return TARIFFS['gpt-4o-mini']
  if (m.includes('gpt-4o') && m.includes('mini')) return TARIFFS['gpt-4o-mini']
  return null
}

export function estimateUsd(
  t: Tariff,
  prompt: number,
  cached: number,
  output: number,
): {
  inputUncachedUsd: number
  inputCachedUsd: number
  inputUsd: number
  outputUsd: number
  totalUsd: number
} {
  const uncached = Math.max(0, prompt - cached)
  const safeCached = Math.max(0, cached)
  const inputUncachedUsd = (uncached / 1e6) * t.inputPerM
  const inputCachedUsd = (safeCached / 1e6) * t.cacheReadPerM
  const inputUsd = inputUncachedUsd + inputCachedUsd
  const outputUsd = (Math.max(0, output) / 1e6) * t.outputPerM
  return {
    inputUncachedUsd,
    inputCachedUsd,
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
  }
}
