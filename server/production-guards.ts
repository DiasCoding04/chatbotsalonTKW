export function assertProductionEnv(): void {
  if (process.env.NODE_ENV !== 'production') return

  const missing: string[] = []
  const geminiKey =
    process.env.GEMINI_API_KEY?.trim() || process.env.VITE_GEMINI_API_KEY?.trim()
  if (!geminiKey) missing.push('GEMINI_API_KEY')
  if (!process.env.CONTEXT_EDITOR_TOKEN?.trim()) missing.push('CONTEXT_EDITOR_TOKEN')

  if (missing.length) {
    throw new Error(
      `Thiếu biến môi trường bắt buộc khi NODE_ENV=production: ${missing.join(', ')}`,
    )
  }
}
