#!/usr/bin/env bash
# Cập nhật in-place — GIỮ NGUYÊN .env, .htaccess, data/, public/CONTEXT.md đang chạy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Cần Node 20+ trên server."
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Thiếu $ROOT/.env — đây không phải bản update cho server đã cấu hình."
  echo "Dùng deploy/onepanel/go.sh cho lần cài đầu."
  exit 1
fi

echo "[update] npm ci --omit=dev"
npm ci --omit=dev

if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe salon-chat-gemini >/dev/null 2>&1; then
    echo "[update] pm2 restart salon-chat-gemini"
    pm2 restart salon-chat-gemini --update-env
  else
    echo "[update] pm2 start (chưa thấy process cũ)"
    pm2 start deploy/pm2.ecosystem.config.cjs
  fi
  pm2 save 2>/dev/null || true
elif command -v systemctl >/dev/null 2>&1 && systemctl status salon-chat-gemini >/dev/null 2>&1; then
  echo "[update] systemctl restart salon-chat-gemini"
  sudo systemctl restart salon-chat-gemini
else
  echo "Không tìm thấy pm2 hoặc systemd unit. Tự restart tiến trình node hiện tại."
  exit 1
fi

sleep 2
PORT="$(grep -E '^CONTEXT_CACHE_SERVER_PORT=' "$ROOT/.env" | head -n1 | cut -d= -f2- | tr -d '\r' || true)"
PORT="${PORT:-8787}"
if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
  echo "[update] OK — /api/health 200 (http://127.0.0.1:${PORT})"
else
  echo "[update] CẢNH BÁO — /api/health không 200. Xem pm2 logs salon-chat-gemini"
  exit 1
fi

echo "Xong. Mở https://chatbot.salontukawa.com để xác nhận (Ctrl+F5 để bỏ cache trình duyệt)."
