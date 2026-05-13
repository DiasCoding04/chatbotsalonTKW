/**
 * pack-update.mjs — gói cập nhật cho server đã chạy ổn định.
 *
 * Cập nhật TOÀN BỘ nội dung project (code, dist, public, data, deploy, ảnh mẫu).
 * Chỉ KHÔNG đụng:
 *   - .env                   (API key Gemini, token CONTEXT_EDITOR_TOKEN, port… của server thật)
 *   - .htaccess              (cấu hình reverse proxy LiteSpeed/Apache của server thật)
 *   - deploy/env/            (file mẫu, có thể chứa secret cũ — tránh đè secret thật)
 *
 * Mọi nội dung khác đều được đẩy lên để đồng bộ với source.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, 'release', 'salon-chat-gemini-update')

function copyDirFiltered(src, dest, skipNames) {
  if (!existsSync(src)) return
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue
    cpSync(join(src, entry.name), join(dest, entry.name), { recursive: true })
  }
}

if (!existsSync(resolve(root, 'dist', 'index.html'))) {
  console.error('Chưa có dist/. Chạy: npm run build:prod')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const FULL_COPIES = [
  'dist',
  'dist-server',
  'server',
  'shared',
  'public',
  'data',
  'package.json',
  'package-lock.json',
]
for (const rel of FULL_COPIES) {
  const src = resolve(root, rel)
  if (!existsSync(src)) continue
  cpSync(src, resolve(outDir, rel), { recursive: true })
}

copyDirFiltered(resolve(root, 'deploy'), resolve(outDir, 'deploy'), new Set(['env']))

writeFileSync(
  resolve(outDir, 'HUONG-DAN-UPDATE.txt'),
  [
    'Cập nhật chatbot Salon Tukawa — toàn bộ nội dung mới.',
    'Server CHỈ giữ nguyên: .env và .htaccess (cấu hình + key).',
    '',
    'Trên máy local:',
    '  npm run build:prod',
    '  npm run pack:update',
    '',
    'Trên server (Terminal cPanel / SSH), trong thư mục gốc app:',
    '  tar -xzf salon-chat-gemini-update.tgz --strip-components=1',
    '  bash deploy/onepanel/update.sh',
    '',
    'Script update.sh sẽ: npm ci --omit=dev → pm2 restart → kiểm tra /api/health.',
    'Cache trình duyệt: bấm Ctrl+F5 khi mở lại trang để chắc chắn dùng asset mới.',
  ].join('\n'),
  'utf8',
)

const archive = resolve(root, 'release', 'salon-chat-gemini-update.tgz')
rmSync(archive, { force: true })
execSync(`tar -czf "${archive}" -C "${resolve(root, 'release')}" salon-chat-gemini-update`, {
  stdio: 'inherit',
})

console.log(`Đã đóng gói: ${archive}`)
