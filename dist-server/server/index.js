import { createServer } from 'node:http';
import { writeMaybeCompressed } from "./compression.js";
import { contextEditTokenRequired, verifyContextEditToken } from "./context-auth.js";
import { resolveGeminiContextCacheTtlSeconds } from "./context-cache-ttl.js";
import { ensureSharedContextCache, purgeAllSharedContextCachesRemote, } from "./context-cache-store.js";
import { ensureContextFile, readContextDocument, readImageSamplesDocument, writeContextDocument, } from "./context-store.js";
import { getServerGeminiApiKey } from "./gemini-api-key.js";
import { loadEnvFile } from "./load-env.js";
import { assertProductionEnv } from "./production-guards.js";
import { readJsonBody } from "./request-body.js";
import { applySecurityHeaders } from "./security-headers.js";
import { canServeStaticBuild, tryServeStatic } from "./static.js";
import { tryProxyUpstream } from "./upstream-proxy.js";
import { useVertexGeminiBackend } from "./vertex-auth.js";
import { handleFacebookApi, startFacebookMessagingBootstrap } from "./facebook.js";
loadEnvFile();
assertProductionEnv();
const PORT = Number(process.env.PORT) ||
    Number(process.env.CONTEXT_CACHE_SERVER_PORT) ||
    8787;
const HOST = process.env.CONTEXT_CACHE_SERVER_HOST?.trim() || '0.0.0.0';
const DEFAULT_MODEL = process.env.VITE_GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite';
const PUBLIC_URL = process.env.APP_PUBLIC_URL?.trim() || '';
const MAX_CONTEXT_CHARS = Number(process.env.CONTEXT_MAX_CHARS) || 500_000;
const MAX_ENSURE_SYSTEM_PROMPT_CHARS = Number(process.env.GEMINI_ENSURE_SYSTEM_PROMPT_MAX_CHARS) > 0
    ? Math.floor(Number(process.env.GEMINI_ENSURE_SYSTEM_PROMPT_MAX_CHARS))
    : Math.min(950_000, Math.max(MAX_CONTEXT_CHARS * 2, MAX_CONTEXT_CHARS));
function makeSendJson(req) {
    return (res, status, body) => {
        applySecurityHeaders(res);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        writeMaybeCompressed(req, res, JSON.stringify(body));
    };
}
function contextApiPayload(doc) {
    return {
        content: doc.content,
        updatedAt: doc.updatedAt,
        requiresEditToken: contextEditTokenRequired(),
    };
}
const server = createServer((req, res) => {
    const sendJson = makeSendJson(req);
    void (async () => {
        const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const url = requestUrl.pathname;
        if (req.method === 'GET' && url === '/api/health') {
            const geminiBackend = useVertexGeminiBackend() ? 'vertex' : 'developer';
            sendJson(res, 200, {
                ok: true,
                staticBuild: canServeStaticBuild(),
                contextEditTokenRequired: contextEditTokenRequired(),
                publicUrl: PUBLIC_URL || null,
                geminiBackend,
                geminiServerReady: geminiBackend === 'vertex' || Boolean(getServerGeminiApiKey()),
                geminiProxyKeyInjected: Boolean(getServerGeminiApiKey()),
                geminiContextCacheTtlS: resolveGeminiContextCacheTtlSeconds(),
            });
            return;
        }
        if (url === '/api/context' && (req.method === 'GET' || req.method === 'PUT')) {
            if (req.method === 'GET') {
                const doc = await readContextDocument();
                sendJson(res, 200, contextApiPayload(doc));
                return;
            }
            if (!verifyContextEditToken(req)) {
                sendJson(res, 401, { error: 'Sai hoặc thiếu mã chỉnh sửa CONTEXT.' });
                return;
            }
            const body = (await readJsonBody(req));
            if (typeof body.content !== 'string') {
                sendJson(res, 400, { error: 'Thiếu trường content (chuỗi markdown).' });
                return;
            }
            if (body.content.length > MAX_CONTEXT_CHARS) {
                sendJson(res, 413, {
                    error: `CONTEXT vượt quá ${MAX_CONTEXT_CHARS} ký tự.`,
                });
                return;
            }
            const doc = await writeContextDocument(body.content);
            await purgeAllSharedContextCachesRemote(getServerGeminiApiKey());
            sendJson(res, 200, contextApiPayload(doc));
            return;
        }
        if (req.method === 'GET' && url === '/api/image-samples') {
            const doc = await readImageSamplesDocument();
            sendJson(res, 200, {
                content: doc.content,
                updatedAt: doc.updatedAt,
                baseUrl: process.env.IMAGE_SAMPLES_BASE_URL?.trim() || '',
            });
            return;
        }
        if (await handleFacebookApi(req, res, requestUrl))
            return;
        if (req.method === 'POST' && url === '/api/context-cache/ensure') {
            const apiKey = getServerGeminiApiKey();
            if (!useVertexGeminiBackend() && !apiKey) {
                sendJson(res, 500, { error: 'Thiếu GEMINI_API_KEY trên server.' });
                return;
            }
            const body = (await readJsonBody(req));
            const systemPrompt = body.systemPrompt?.trim();
            if (!systemPrompt) {
                sendJson(res, 400, { error: 'Thiếu systemPrompt.' });
                return;
            }
            if (systemPrompt.length > MAX_ENSURE_SYSTEM_PROMPT_CHARS) {
                sendJson(res, 413, {
                    error: `systemPrompt quá dài (${systemPrompt.length} ký tự). Tối đa ${MAX_ENSURE_SYSTEM_PROMPT_CHARS}.`,
                });
                return;
            }
            const model = body.model?.trim() || DEFAULT_MODEL;
            const rawTtl = body.ttlSeconds;
            const n = typeof rawTtl === 'number' ? rawTtl : Number(rawTtl);
            const ttlSeconds = Number.isFinite(n) && n > 0
                ? Math.min(86_400, Math.max(60, Math.floor(n)))
                : resolveGeminiContextCacheTtlSeconds();
            try {
                const result = await ensureSharedContextCache(apiKey, model, systemPrompt, ttlSeconds);
                sendJson(res, 200, result);
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                const isTimeout = /timed out|timeout|AbortError|abort/i.test(msg);
                console.warn('[context-cache ensure]', isTimeout ? 'timeout' : 'error', msg.slice(0, 500));
                sendJson(res, isTimeout ? 504 : 502, { error: msg.slice(0, 2000) });
            }
            return;
        }
        if (req.method === 'POST' && url === '/api/context-cache/purge') {
            if (!verifyContextEditToken(req)) {
                sendJson(res, 401, { error: 'Sai hoặc thiếu mã chỉnh sửa CONTEXT.' });
                return;
            }
            const apiKey = getServerGeminiApiKey();
            if (!useVertexGeminiBackend() && !apiKey) {
                sendJson(res, 500, { error: 'Thiếu GEMINI_API_KEY trên server.' });
                return;
            }
            try {
                const deleted = await purgeAllSharedContextCachesRemote(apiKey);
                sendJson(res, 200, { ok: true, deletedRemote: deleted });
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                sendJson(res, 500, { error: msg });
            }
            return;
        }
        if (tryProxyUpstream(req, res))
            return;
        if (tryServeStatic(req, res))
            return;
        sendJson(res, 404, { error: 'Not found' });
    })().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        try {
            sendJson(res, 500, { error: msg });
        }
        catch {
            try {
                res.statusCode = 500;
                res.end();
            }
            catch {
                /* ignore */
            }
        }
    });
});
function scheduleRemoteContextCachePurgeOnShutdown() {
    const raw = process.env.GEMINI_CONTEXT_CACHE_PURGE_ON_SHUTDOWN?.trim().toLowerCase();
    const explicitOff = raw === '0' || raw === 'false' || raw === 'no';
    const explicitOn = raw === '1' || raw === 'true' || raw === 'yes';
    const defaultOn = process.env.NODE_ENV !== 'production';
    if (explicitOff || (!explicitOn && !defaultOn))
        return;
    const run = () => {
        const key = getServerGeminiApiKey();
        void purgeAllSharedContextCachesRemote(key).then((count) => {
            if (count > 0) {
                console.log(`[context-cache] Đã xoá ${count} cachedContent trên Google (shutdown).`);
            }
        });
    };
    process.once('SIGINT', run);
    process.once('SIGTERM', run);
}
scheduleRemoteContextCachePurgeOnShutdown();
void ensureContextFile().then(() => {
    server.listen(PORT, HOST, () => {
        const modes = ['api', 'proxy'];
        if (canServeStaticBuild())
            modes.push('static');
        const publicLabel = PUBLIC_URL ? ` · ${PUBLIC_URL}` : '';
        const ctxBackend = process.env.CONTEXT_BACKEND?.trim() || (process.env.K_SERVICE ? 'firestore' : 'file');
        console.log(`[context-cache] http://${HOST}:${PORT} (${modes.join(' + ')})${publicLabel}`);
        console.log(`[context] backend=${ctxBackend} idleKillMin=${Math.round((Number(process.env.GEMINI_CONTEXT_CACHE_IDLE_MS) || 1_800_000) / 60_000)}`);
        if (!contextEditTokenRequired()) {
            console.warn('[context-cache] CONTEXT_EDITOR_TOKEN chưa đặt — ai cũng có thể PUT /api/context. Đặt token trước khi mở domain.');
        }
        startFacebookMessagingBootstrap();
    });
});
