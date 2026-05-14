function isRunningOnGoogleCloud(): boolean {
  return Boolean(process.env.K_SERVICE || process.env.GAE_SERVICE || process.env.GOOGLE_CLOUD_PROJECT)
}

export function assertProductionEnv(): void {
  if (process.env.NODE_ENV !== 'production') return

  const missing: string[] = []
  const useVertex = process.env.GEMINI_BACKEND?.trim().toLowerCase() === 'vertex'
  if (useVertex) {
    if (!process.env.VERTEX_AI_PROJECT_ID?.trim()) missing.push('VERTEX_AI_PROJECT_ID')
    if (
      !process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() &&
      !process.env.VERTEX_SERVICE_ACCOUNT_JSON?.trim() &&
      !isRunningOnGoogleCloud()
    ) {
      missing.push('GOOGLE_APPLICATION_CREDENTIALS')
    }
  } else {
    const geminiKey =
      process.env.GEMINI_API_KEY?.trim() || process.env.VITE_GEMINI_API_KEY?.trim()
    if (!geminiKey) missing.push('GEMINI_API_KEY')
  }
  if (!process.env.CONTEXT_EDITOR_TOKEN?.trim()) missing.push('CONTEXT_EDITOR_TOKEN')

  if (missing.length) {
    throw new Error(
      `Thiếu biến môi trường bắt buộc khi NODE_ENV=production: ${missing.join(', ')}`,
    )
  }
}
