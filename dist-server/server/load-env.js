import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
function stripQuotes(value) {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        return v.slice(1, -1);
    return v;
}
/** Gán từng dòng KEY=VAL vào process.env */
function applyEnvBlock(raw, mode) {
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const i = trimmed.indexOf('=');
        if (i <= 0)
            continue;
        const key = trimmed.slice(0, i).trim();
        const value = stripQuotes(trimmed.slice(i + 1));
        if (!key)
            continue;
        if (mode === 'fill' && key in process.env)
            continue;
        process.env[key] = value;
    }
}
/**
 * Đọc biến môi trường giống dotenv:
 * - `.env` (chỉ điền key chưa có trong process — giữ secret từ Docker/system)
 * - `.env.local` (ghi đè key có trong file — dùng cho máy dev)
 * - `.env.vertex.local` (ghi đè — cùng file `scripts/run-vertex-local.ps1` nạp; thường có FACEBOOK_*)
 * - `.env.production` khi NODE_ENV=production
 */
export function loadEnvFile(_ignoredPath) {
    const root = process.cwd();
    const chain = [
        { path: resolve(root, '.env'), mode: 'fill' },
        { path: resolve(root, '.env.local'), mode: 'override' },
        { path: resolve(root, '.env.vertex.local'), mode: 'override' },
    ];
    if (process.env.NODE_ENV === 'production') {
        chain.push({ path: resolve(root, '.env.production'), mode: 'override' });
    }
    for (const { path, mode } of chain) {
        if (!existsSync(path))
            continue;
        try {
            applyEnvBlock(readFileSync(path, 'utf8'), mode);
        }
        catch {
            /* bỏ qua file lỗi đọc */
        }
    }
}
