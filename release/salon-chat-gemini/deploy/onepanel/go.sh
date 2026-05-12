#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Cần Node 20+ trên server."
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Thiếu $ROOT/.env"
  exit 1
fi

npm ci --omit=dev

if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe salon-chat-gemini >/dev/null 2>&1; then
    pm2 restart deploy/pm2.ecosystem.config.cjs
  else
    pm2 start deploy/pm2.ecosystem.config.cjs
  fi
  pm2 save 2>/dev/null || true
else
  echo "Chưa có pm2. Cài: npm i -g pm2"
  echo "Hoặc chạy nền: nohup npm run start:prod > app.log 2>&1 &"
  exit 1
fi

sleep 2
PORT="$(grep -E '^CONTEXT_CACHE_SERVER_PORT=' "$ROOT/.env" | head -n1 | cut -d= -f2- | tr -d '\r' || true)"
PORT="${PORT:-8787}"
curl -fsS "http://127.0.0.1:${PORT}/api/health"
echo
echo "Xong. Mở https://chatbot.salontukawa.com"
