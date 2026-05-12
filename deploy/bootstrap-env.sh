#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

cp deploy/env/server.env .env
chmod 600 .env 2>/dev/null || true
echo "Đã tạo $ROOT/.env"
