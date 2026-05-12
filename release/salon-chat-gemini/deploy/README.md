# Deploy `chatbot.salontukawa.com`

## 1. Trên máy local (Windows)

```powershell
cd C:\Users\pc\Downloads\salon-chat-gemini
Copy-Item .env.production.example .env.production -Force
# Sửa .env.production: dán VITE_GEMINI_API_KEY, giữ VITE_GEMINI_PROXY_INJECTS_KEY=false
npm ci
npm run build:prod
npm run pack:release
```

File upload: `release/salon-chat-gemini.tgz`

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

Local: `build:prod` → `pack:release` → upload tgz → trên server:

```bash
cd /var/www/salon-chat-gemini
sudo -u salon-chat tar -xzf /tmp/salon-chat-gemini.tgz --strip-components=1
sudo -u salon-chat npm ci --omit=dev
sudo systemctl restart salon-chat-gemini
```
