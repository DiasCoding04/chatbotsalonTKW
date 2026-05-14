# Deploy `chatbot.salontukawa.com`

## 1. Trên máy local (Windows)

```powershell
cd C:\Users\pc\Downloads\salon-chat-gemini
Copy-Item .env.production.example .env.production -Force
# Sửa .env.production: dán VITE_GEMINI_API_KEY, giữ VITE_GEMINI_PROXY_INJECTS_KEY=false
# Đặt APP_PUBLIC_URL=https://chatbot.salontukawa.com
npm ci
npm run build:prod
npm run pack:release
```

File upload: `release/salon-chat-gemini.tgz`

## Vertex AI

If you use Vertex AI, set these environment variables in production:

- `GEMINI_BACKEND=vertex`
- `VERTEX_AI_PROJECT_ID=<your-project-id>`
- `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`
  or
- `VERTEX_SERVICE_ACCOUNT_JSON=<service-account-json>`

If deploying to Cloud Run, you can also rely on the Cloud Run service account and omit the explicit credentials file/JSON, because the app now supports Google Cloud metadata-based credentials.

Also keep:
- `NODE_ENV=production`
- `APP_PUBLIC_URL=https://chatbot.salontukawa.com`
- `CONTEXT_EDITOR_TOKEN=<secret>`

## 2. DNS

Trỏ `A` `chatbot.salontukawa.com` → IP VPS.

## 3. Trên VPS (Ubuntu)

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo mkdir -p /var/www
sudo tar -xzf salon-chat-gemini.tgz -C /var/www

cd /var/www/salon-chat-gemini
cp deploy/env/server.env.minimal.example .env
nano .env   # VITE_GEMINI_API_KEY giống lúc build local
sudo bash deploy/install-on-server.sh
sudo certbot --nginx -d chatbot.salontukawa.com
curl -fsS https://chatbot.salontukawa.com/api/health
```

## 4. Cập nhật sau này

> Trên server đã có `.env`, `.htaccess`, `data/CONTEXT.md` chạy thật — KHÔNG đè.

### Cách nhanh (khuyến nghị, cPanel/DirectAdmin + PM2)

Local:

```powershell
npm run build:prod
npm run pack:update
```

File upload: `release/salon-chat-gemini-update.tgz` (đã kèm code, ảnh mẫu, CONTEXT.md, IMAGE_SAMPLES.md, deploy/…).

Trên server (Terminal cPanel hoặc SSH), `cd` vào thư mục gốc app (cùng cấp `.env`):

```bash
tar -xzf salon-chat-gemini-update.tgz --strip-components=1
bash deploy/onepanel/update.sh
```

`update.sh` tự `npm ci --omit=dev`, restart PM2/systemd, kiểm tra `/api/health`.
Gói update đẩy **toàn bộ** nội dung mới, chỉ **không chứa** `.env` và `.htaccess` —
hai file cấu hình runtime + secret được giữ nguyên trên server.

### Cách cũ (deploy lại từ đầu — sẽ đè .env nếu không cẩn thận)

```bash
cd /var/www/salon-chat-gemini
sudo -u salon-chat tar -xzf /tmp/salon-chat-gemini.tgz --strip-components=1
sudo -u salon-chat npm ci --omit=dev
sudo systemctl restart salon-chat-gemini
```
