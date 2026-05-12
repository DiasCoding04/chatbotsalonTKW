import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      // Gọi Gemini qua dev proxy → same-origin → KHÔNG có CORS preflight.
      // Code client luôn fetch '/gemini-api/...' (xem src/lib/gemini.ts).
      '/gemini-api': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gemini-api/, ''),
        // QUAN TRỌNG cho streamGenerateContent (SSE):
        // - Buộc upstream KHÔNG nén → http-proxy không buffer để giải nén
        //   trước khi forward chunks về browser. Nếu để gzip, browser sẽ
        //   thấy `Response` chỉ sau khi proxy nhận xong toàn bộ body
        //   (Chờ chữ đầu hiển thị ~0ms nhưng HTTP phình lên = giả streaming).
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept-Encoding', 'identity')
          })
        },
      },
      '/openai-api': {
        target: 'https://api.openai.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/openai-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Accept-Encoding', 'identity')
          })
        },
      },
    },
  },
})
