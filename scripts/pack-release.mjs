import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outDir = resolve(root, 'release', 'salon-chat-gemini')

if (!existsSync(resolve(root, 'dist', 'index.html'))) {
  console.error('Chưa có dist/. Chạy: npm run build:prod')
  process.exit(1)
}

const serverEnv = resolve(root, 'deploy', 'env', 'server.env')
if (!existsSync(serverEnv)) {
  console.error('Thiếu deploy/env/server.env')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const copyPaths = [
  'dist',
  'server',
  'shared',
  'public',
  'data',
  'deploy',
  'package.json',
  'package-lock.json',
]
for (const rel of copyPaths) {
  const src = resolve(root, rel)
  if (!existsSync(src)) continue
  const dest = resolve(outDir, rel)
  cpSync(src, dest, { recursive: true })
}

cpSync(serverEnv, resolve(outDir, '.env'))
cpSync(resolve(root, 'deploy', 'htaccess'), resolve(outDir, '.htaccess'))

writeFileSync(
  resolve(outDir, 'HUONG-DAN.txt'),
  [
    'OnePanel / Apache (reverse proxy đã cấu hình → 127.0.0.1:8787)',
    '',
    '1. Upload và giải nén toàn bộ thư mục này vào document root site.',
    '2. SSH vào server, cd vào đúng thư mục vừa giải nén.',
    '3. Chạy:',
    '   bash deploy/onepanel/go.sh',
    '',
    'Cập nhật sau: upload đè file mới rồi chạy lại bước 3.',
    'Không chạy npm run build trên server.',
  ].join('\n'),
  'utf8',
)

const archive = resolve(root, 'release', 'salon-chat-gemini.tgz')
rmSync(archive, { force: true })
execSync(`tar -czf "${archive}" -C "${resolve(root, 'release')}" salon-chat-gemini`, {
  stdio: 'inherit',
})

console.log(`Đã đóng gói: ${archive}`)
