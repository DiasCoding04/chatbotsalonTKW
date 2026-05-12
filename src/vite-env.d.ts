/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AI_PROVIDER: string
  readonly VITE_OPENAI_API_KEY: string
  readonly VITE_OPENAI_MODEL: string
  readonly VITE_GEMINI_API_KEY: string
  readonly VITE_GEMINI_PROXY_INJECTS_KEY: string
  readonly VITE_GEMINI_MODEL: string
  readonly VITE_CONTEXT_CACHE_SCOPE: string
  readonly VITE_MAX_OUTPUT_TOKENS: string
  readonly VITE_USD_VND: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*?raw' {
  const content: string
  export default content
}
