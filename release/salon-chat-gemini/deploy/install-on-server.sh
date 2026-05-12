#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/salon-chat-gemini}"
DOMAIN="${DOMAIN:-chatbot.salontukawa.com}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Chạy bằng sudo: sudo bash deploy/install-on-server.sh"
  exit 1
fi

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "Chưa có app tại $APP_DIR. Giải nén release vào thư mục này trước."
  exit 1
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/deploy/env/server.env.minimal.example" "$APP_DIR/.env"
  echo "Đã tạo $APP_DIR/.env — sửa VITE_GEMINI_API_KEY rồi chạy lại script."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Cài Node 20+ trước (nodesource setup_22.x)."
  exit 1
fi

id salon-chat >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin salon-chat
chown -R salon-chat:salon-chat "$APP_DIR"

cd "$APP_DIR"
sudo -u salon-chat npm ci --omit=dev

install -m 0644 "$APP_DIR/deploy/systemd/salon-chat-gemini.service" /etc/systemd/system/salon-chat-gemini.service
systemctl daemon-reload
systemctl enable --now salon-chat-gemini

if command -v nginx >/dev/null 2>&1; then
  install -m 0644 "$APP_DIR/deploy/nginx/chatbot.salontukawa.com.conf" \
    "/etc/nginx/sites-available/${DOMAIN}.conf"
  ln -sf "/etc/nginx/sites-available/${DOMAIN}.conf" /etc/nginx/sites-enabled/
  nginx -t
  systemctl reload nginx
  echo "Nginx đã reload. Nếu chưa có SSL: certbot --nginx -d ${DOMAIN}"
else
  echo "Chưa cài nginx — app chạy cổng trong .env (mặc định 8787)."
fi

echo "Kiểm tra: curl -fsS http://127.0.0.1:8787/api/health"
