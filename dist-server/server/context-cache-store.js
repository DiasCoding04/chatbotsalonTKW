import { buildContextCacheFingerprint } from "../shared/context-cache-key.js";
import { estimateContextCacheTokens, GEMINI_CONTEXT_CACHE_MIN_TOKENS, isContextCacheEligible, } from "../shared/context-cache-eligibility.js";
import { clearContextCacheActivityInFirestore, clearSharedContextCacheInFirestore, readContextCacheLastActivityMs, readContextFromFirestore, releaseContextCacheCreateLock, tryAcquireContextCacheCreateLock, touchContextCacheActivityInFirestore, useFirestoreContextBackend, writeSharedContextCacheToFirestore, } from "./context-firestore.js";
import { ContextCacheIneligibleError, createCachedContentWithRetry, deleteCachedContent, listAllCachedContentNames, } from "./gemini-cache.js";
const DEFAULT_CACHE_IDLE_MS = 30 * 60 * 1000;
export function resolveContextCacheIdleMs() {
    const raw = process.env.GEMINI_CONTEXT_CACHE_IDLE_MS?.trim();
    if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 60_000)
            return Math.floor(n);
    }
    return DEFAULT_CACHE_IDLE_MS;
}
/** Tin AI mới — gia hạn idle window (Firestore, dùng chung mọi instance). */
export async function touchContextCacheActivity() {
    if (!useFirestoreContextBackend())
        return;
    await touchContextCacheActivityInFirestore();
}
const EXPIRE_BUFFER_MS = 30_000;
const entries = new Map();
const inflight = new Map();
let ensureCacheSerial = Promise.resolve();
/** TTL giữa các lần list+reconcile Vertex (file backend; Firestore dùng registry). */
const RECONCILE_MIN_INTERVAL_MS = 30 * 60 * 1000;
let lastReconcileAt = 0;
const EXPIRE_BUFFER_MS_FIRESTORE = 30_000;
async function finishCachedResult(result) {
    if (result.mode === 'cached') {
        await touchContextCacheActivity();
    }
    return result;
}
/** Xóa mọi cachedContent trên Vertex trừ bản canonical (luôn 1 cache). */
async function enforceRemoteSingletonKeepOnly(apiKey, keepName) {
    const keep = keepName.trim();
    if (!keep)
        return 0;
    let remoteNames = [];
    try {
        remoteNames = await listAllCachedContentNames(apiKey);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[context-cache] enforce singleton list failed:', msg);
        return 0;
    }
    let n = 0;
    for (const name of remoteNames) {
        if (name.trim() === keep)
            continue;
        await deleteCachedContent(apiKey, name);
        n += 1;
    }
    if (n > 0) {
        console.log(`[context-cache] singleton: deleted ${n} extra remote cache(s)`);
    }
    return n;
}
async function adoptFirestoreSharedCache(apiKey, fingerprint, estimatedTokens) {
    const doc = await readContextFromFirestore();
    const shared = doc?.sharedContextCache;
    if (!shared || shared.fingerprint !== fingerprint)
        return null;
    if (shared.expireAtMs <= Date.now() + EXPIRE_BUFFER_MS_FIRESTORE)
        return null;
    await enforceRemoteSingletonKeepOnly(apiKey, shared.name);
    entries.set(fingerprint, {
        fingerprint,
        name: shared.name,
        expireAt: shared.expireAtMs,
    });
    return finishCachedResult({
        mode: 'cached',
        name: shared.name,
        reused: true,
        expireAt: shared.expireAtMs,
        estimatedTokens,
    });
}
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
    await reconcileSingletonRemoteContextCache(apiKey, fingerprint);
}
/**
 * Đảm bảo trên Vertex/Google chỉ còn tối đa 1 cachedContent (hoặc 0 trước khi tạo mới).
 * Trả về số bản ghi đã xóa.
 */
export async function reconcileSingletonRemoteContextCache(apiKey, fingerprint) {
    let remoteNames = [];
    try {
        remoteNames = await listAllCachedContentNames(apiKey);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[context-cache] list failed during reconcile:', msg);
        return 0;
    }
    const local = entries.get(fingerprint);
    const localName = local?.name?.trim();
    if (remoteNames.length === 0) {
        if (local)
            entries.delete(fingerprint);
        lastReconcileAt = Date.now();
        return 0;
    }
    if (remoteNames.length === 1) {
        const only = remoteNames[0].trim();
        if (local && localName === only && isValid(local, fingerprint)) {
            lastReconcileAt = Date.now();
            return 0;
        }
        let expireAt = local?.expireAt ?? Date.now() + 3_600_000;
        if (!local || localName !== only) {
            entries.set(fingerprint, { fingerprint, name: only, expireAt });
            console.log('[context-cache] singleton: adopted remote cache', only.slice(-24));
        }
        lastReconcileAt = Date.now();
        return 0;
    }
    const keep = localName && remoteNames.some((n) => n.trim() === localName) ? localName : remoteNames[0].trim();
    let n = 0;
    for (const name of remoteNames) {
        const trimmed = name.trim();
        if (trimmed === keep)
            continue;
        await deleteCachedContent(apiKey, trimmed);
        n += 1;
    }
    entries.set(fingerprint, {
        fingerprint,
        name: keep,
        expireAt: local?.expireAt ?? Date.now() + 3_600_000,
    });
    if (n > 0) {
        console.log(`[context-cache] singleton reconcile: deleted ${n} duplicate remote cache(s)`);
    }
    lastReconcileAt = Date.now();
    return n;
}
/** Không có tin mới trong cửa sổ idle → xóa cache Vertex (tiết kiệm storage). */
export async function evictContextCacheIfIdle(apiKey) {
    if (!useFirestoreContextBackend())
        return false;
    const lastMs = await readContextCacheLastActivityMs();
    if (lastMs == null)
        return false;
    const idleMs = resolveContextCacheIdleMs();
    if (Date.now() - lastMs < idleMs)
        return false;
    const deleted = await purgeAllSharedContextCachesRemote(apiKey);
    await clearContextCacheActivityInFirestore();
    console.log(`[context-cache] Idle ${Math.round(idleMs / 60_000)} phút — đã xóa ${deleted} cache remote`);
    return true;
}
/**
 * Xoá 100% cachedContent trên Google/Vertex (list API + entry local) và làm sạch store.
 * Dùng khi deploy, sửa CONTEXT — tránh cache cũ treo phí storage.
 */
export async function purgeAllSharedContextCachesRemote(apiKey) {
    await Promise.allSettled([...inflight.values()]);
    inflight.clear();
    let remoteNames = [];
    try {
        remoteNames = await listAllCachedContentNames(apiKey);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[context-cache] listAllCachedContentNames failed — purge local only:', msg);
    }
    const seen = new Set();
    const toDelete = [];
    for (const name of [...remoteNames, ...[...entries.values()].map((e) => e.name)]) {
        const trimmed = name.trim();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        toDelete.push(trimmed);
    }
    let n = 0;
    for (const name of toDelete) {
        await deleteCachedContent(apiKey, name);
        n += 1;
    }
    entries.clear();
    lastReconcileAt = Date.now();
    await clearContextCacheActivityInFirestore().catch(() => undefined);
    await clearSharedContextCacheInFirestore().catch(() => undefined);
    return n;
}
export async function ensureSharedContextCache(apiKey, model, systemPrompt, ttlSeconds) {
    await evictContextCacheIfIdle(apiKey);
    const fingerprint = buildContextCacheFingerprint(model, systemPrompt);
    const estimatedTokens = estimateContextCacheTokens(systemPrompt);
    const now = Date.now();
    if (!isContextCacheEligible(systemPrompt)) {
        console.warn(`[context-cache] Bỏ qua tạo cache — ước tính ${estimatedTokens} token (< ${GEMINI_CONTEXT_CACHE_MIN_TOKENS}). Dùng inline systemInstruction.`);
        return {
            mode: 'inline',
            name: null,
            reused: false,
            expireAt: now,
            estimatedTokens,
            reason: 'below_min_tokens',
        };
    }
    if (useFirestoreContextBackend()) {
        const fromRegistry = await adoptFirestoreSharedCache(apiKey, fingerprint, estimatedTokens);
        if (fromRegistry)
            return fromRegistry;
    }
    const existing = entries.get(fingerprint);
    if (existing && isValid(existing, fingerprint, now)) {
        if (now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) {
            return finishCachedResult({
                mode: 'cached',
                name: existing.name,
                reused: true,
                expireAt: existing.expireAt,
                estimatedTokens,
            });
        }
        const deleted = await reconcileSingletonRemoteContextCache(apiKey, fingerprint);
        if (deleted === 0) {
            return finishCachedResult({
                mode: 'cached',
                name: existing.name,
                reused: true,
                expireAt: existing.expireAt,
                estimatedTokens,
            });
        }
    }
    let pending = inflight.get(fingerprint);
    if (!pending) {
        pending = ensureCacheSerial
            .then(async () => {
            const again = entries.get(fingerprint);
            if (again && isValid(again, fingerprint, now)) {
                if (now - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS)
                    return again;
                const deleted = await reconcileSingletonRemoteContextCache(apiKey, fingerprint);
                if (deleted === 0)
                    return again;
            }
            if (useFirestoreContextBackend()) {
                const raced = await adoptFirestoreSharedCache(apiKey, fingerprint, estimatedTokens);
                if (raced)
                    return entries.get(fingerprint) ?? null;
                const gotLock = await tryAcquireContextCacheCreateLock();
                if (!gotLock) {
                    for (let w = 0; w < 12; w++) {
                        await new Promise((r) => setTimeout(r, 500));
                        const waited = await adoptFirestoreSharedCache(apiKey, fingerprint, estimatedTokens);
                        if (waited)
                            return entries.get(fingerprint) ?? null;
                    }
                    console.warn('[context-cache] Không lấy được lock tạo cache — dùng inline.');
                    return null;
                }
                try {
                    const again = await adoptFirestoreSharedCache(apiKey, fingerprint, estimatedTokens);
                    if (again)
                        return entries.get(fingerprint) ?? null;
                    await enforceRemoteSingletonKeepOnly(apiKey, ''); // xóa hết trước khi tạo mới
                    const remoteBefore = await listAllCachedContentNames(apiKey);
                    for (const stale of remoteBefore) {
                        await deleteCachedContent(apiKey, stale);
                    }
                    const info = await createCachedContentWithRetry(apiKey, model, systemPrompt, ttlSeconds);
                    let expireAt = now + ttlSeconds * 1000;
                    if (info.expireTime) {
                        const parsed = Date.parse(info.expireTime);
                        if (Number.isFinite(parsed))
                            expireAt = parsed;
                    }
                    await writeSharedContextCacheToFirestore({
                        name: info.name,
                        fingerprint,
                        expireAtMs: expireAt,
                    });
                    const entry = { fingerprint, name: info.name, expireAt };
                    entries.set(fingerprint, entry);
                    await enforceRemoteSingletonKeepOnly(apiKey, info.name);
                    console.log('[context-cache] singleton: created 1 cache (registry)', info.name.slice(-24));
                    return entry;
                }
                finally {
                    await releaseContextCacheCreateLock();
                }
            }
            await reconcileSingletonRemoteContextCache(apiKey, fingerprint);
            try {
                const info = await createCachedContentWithRetry(apiKey, model, systemPrompt, ttlSeconds);
                let expireAt = now + ttlSeconds * 1000;
                if (info.expireTime) {
                    const parsed = Date.parse(info.expireTime);
                    if (Number.isFinite(parsed))
                        expireAt = parsed;
                }
                const entry = { fingerprint, name: info.name, expireAt };
                entries.set(fingerprint, entry);
                console.log('[context-cache] singleton: created 1 cache', info.name.slice(-24));
                return entry;
            }
            catch (e) {
                if (e instanceof ContextCacheIneligibleError) {
                    console.warn('[context-cache]', e.message);
                    return null;
                }
                throw e;
            }
        })
            .finally(() => {
            inflight.delete(fingerprint);
        });
        inflight.set(fingerprint, pending);
        ensureCacheSerial = pending.then(() => undefined).catch(() => undefined);
    }
    const entry = await pending;
    if (!entry) {
        return {
            mode: 'inline',
            name: null,
            reused: false,
            expireAt: now,
            estimatedTokens,
            reason: 'below_min_tokens',
        };
    }
    return finishCachedResult({
        mode: 'cached',
        name: entry.name,
        reused: existing?.name === entry.name,
        expireAt: entry.expireAt,
        estimatedTokens,
    });
}
