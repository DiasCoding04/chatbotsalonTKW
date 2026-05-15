export function getServerGeminiApiKey() {
    return (process.env.GEMINI_API_KEY?.trim() ||
        process.env.VITE_GEMINI_API_KEY?.trim() ||
        '');
}
