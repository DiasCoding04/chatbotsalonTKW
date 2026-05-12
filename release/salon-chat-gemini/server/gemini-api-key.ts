export function getServerGeminiApiKey(): string {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.VITE_GEMINI_API_KEY?.trim() ||
    ''
  )
}
