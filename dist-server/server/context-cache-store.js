import { buildContextCacheFingerprint } from "../shared/context-cache-key.js";
import { createCachedContentWithRetry, deleteCachedContent } from "./gemini-cache.js";
const EXPIRE_BUFFER_MS = 30_000;
const entries = new Map();
const inflight = new Map();
function isValid(entry, fingerprint, now = Date.now()) {
    return entry.fingerprint === fingerprint && entry.expireAt > now + EXPIRE_BUFFER_MS;
}
export function clearSharedContextCacheStore() {
    entries.clear();
    inflight.clear();
}
/** Xoá cache theo đúng model + systemPrompt (vd. cache hết hạn trên Google nhưng entry local còn). */
export function evictSharedContextCache(model, systemPrompt) {
    const fingerprint = buildContextCacheFingerprint(model, systemPrompt);
    entries.delete(fingerprint);
}
/** Bỏ entry local và xoá bản ghi cache trên Google (dừng billing storage sớm). */
export async function evictSharedContextCacheAndDeleteRemote(apiKey, model, systemPrompt) {
    const fingerprint = buildContextCacheFingerprint(model, systemPrompt);
    const entry = entries.get(fingerprint);
    entries.delete(fingerprint);
    if (entry) {
        await deleteCachedContent(apiKey, entry.name);
    }
}
/** Xoá mọi cache đã biết trên Google và làm sạch store (dùng khi sửa CONTEXT, purge tay, shutdown). */
export async function purgeAllSharedContextCachesRemote(apiKey) {
    await Promise.allSettled([...inflight.values()]);
    const seen = new Set();
    let n = 0;
    for (const entry of entries.values()) {
        if (seen.has(entry.name))
            continue;
        seen.add(entry.name);
        await deleteCachedContent(apiKey, entry.name);
        n += 1;
    }
    entries.clear();
    inflight.clear();
    return n;
}
export async function ensureSharedContextCache(apiKey, model, systemPrompt, ttlSeconds) {
    const fingerprint = buildContextCacheFingerprint(model, systemPrompt);
    const now = Date.now();
    const existing = entries.get(fingerprint);
    if (existing && isValid(existing, fingerprint, now)) {
        return { name: existing.name, reused: true, expireAt: existing.expireAt };
    }
    let pending = inflight.get(fingerprint);
    if (!pending) {
        pending = (async () => {
            const again = entries.get(fingerprint);
            if (again && isValid(again, fingerprint, now))
                return again;
            const info = await createCachedContentWithRetry(apiKey, model, systemPrompt, ttlSeconds);
            let expireAt = now + ttlSeconds * 1000;
            if (info.expireTime) {
                const parsed = Date.parse(info.expireTime);
                if (Number.isFinite(parsed))
                    expireAt = parsed;
            }
            const entry = { fingerprint, name: info.name, expireAt };
            entries.set(fingerprint, entry);
            return entry;
        })().finally(() => {
            inflight.delete(fingerprint);
        });
        inflight.set(fingerprint, pending);
    }
    const entry = await pending;
    return {
        name: entry.name,
        reused: existing?.name === entry.name,
        expireAt: entry.expireAt,
    };
}
