import { estimateContextCacheTokens, GEMINI_CONTEXT_CACHE_MIN_TOKENS, isContextCacheEligible, isMinimumTokenCacheError, } from "../shared/context-cache-eligibility.js";
import { getVertexAccessToken, useVertexGeminiBackend } from "./vertex-auth.js";
export class ContextCacheIneligibleError extends Error {
    estimatedTokens;
    constructor(estimatedTokens) {
        super(`Context cache cần ≥${GEMINI_CONTEXT_CACHE_MIN_TOKENS} token (ước tính ${estimatedTokens}). Gửi inline systemInstruction.`);
        this.name = 'ContextCacheIneligibleError';
        this.estimatedTokens = estimatedTokens;
    }
}
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
function vertexLocation() {
    return process.env.VERTEX_AI_LOCATION?.trim() || 'global';
}
function vertexOrigin(location = vertexLocation()) {
    return location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;
}
function vertexProjectId() {
    const project = process.env.VERTEX_AI_PROJECT_ID?.trim();
    if (!project)
        throw new Error('Thiếu VERTEX_AI_PROJECT_ID cho Vertex AI.');
    return project;
}
function vertexModelName(model) {
    const project = vertexProjectId();
    const location = vertexLocation();
    const modelId = process.env.VERTEX_AI_MODEL?.trim() || model;
    if (modelId.startsWith('projects/'))
        return modelId;
    return `projects/${project}/locations/${location}/publishers/google/models/${modelId.replace(/^models\//, '')}`;
}
async function createVertexCachedContent(model, systemPrompt, ttlSeconds) {
    const project = vertexProjectId();
    const location = vertexLocation();
    const parent = `projects/${project}/locations/${location}`;
    const url = `${vertexOrigin(location)}/v1/${parent}/cachedContents`;
    const fullModel = vertexModelName(model);
    const token = await getVertexAccessToken();
    const fetchMsRaw = process.env.GEMINI_VERTEX_CREATE_CACHE_FETCH_MS?.trim();
    const createCacheFetchMs = Number.isFinite(Number(fetchMsRaw)) && Number(fetchMsRaw) > 5000
        ? Math.floor(Number(fetchMsRaw))
        : 120_000;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: fullModel,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            ttl: `${ttlSeconds}s`,
        }),
        signal: AbortSignal.timeout(createCacheFetchMs),
    }).catch((e) => {
        throw new Error(e instanceof Error ? e.message : String(e));
    });
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `${res.status} ${res.statusText}`);
    const data = JSON.parse(raw);
    if (data.error?.message)
        throw new Error(data.error.message);
    if (!data.name)
        throw new Error('cachedContents: thiếu name');
    return { name: data.name, expireTime: data.expireTime, model: fullModel };
}
export async function createCachedContent(apiKey, model, systemPrompt, ttlSeconds) {
    if (useVertexGeminiBackend()) {
        return createVertexCachedContent(model, systemPrompt, ttlSeconds);
    }
    const url = `${GEMINI_API_BASE}/cachedContents?key=${encodeURIComponent(apiKey)}`;
    const fullModel = model.startsWith('models/') ? model : `models/${model}`;
    const devFetchMsRaw = process.env.GEMINI_DEV_CREATE_CACHE_FETCH_MS?.trim();
    const devFetchMs = Number.isFinite(Number(devFetchMsRaw)) && Number(devFetchMsRaw) > 5000
        ? Math.floor(Number(devFetchMsRaw))
        : 120_000;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: fullModel,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            ttl: `${ttlSeconds}s`,
        }),
        signal: AbortSignal.timeout(devFetchMs),
    }).catch((e) => {
        throw new Error(e instanceof Error ? e.message : String(e));
    });
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `${res.status} ${res.statusText}`);
    const data = JSON.parse(raw);
    if (data.error?.message)
        throw new Error(data.error.message);
    if (!data.name)
        throw new Error('cachedContents: thiếu name');
    return { name: data.name, expireTime: data.expireTime, model: fullModel };
}
export async function createCachedContentWithRetry(apiKey, model, systemPrompt, ttlSeconds, attempts = 3) {
    const estimated = estimateContextCacheTokens(systemPrompt);
    if (!isContextCacheEligible(systemPrompt)) {
        throw new ContextCacheIneligibleError(estimated);
    }
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await createCachedContent(apiKey, model, systemPrompt, ttlSeconds);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (isMinimumTokenCacheError(msg)) {
                throw new ContextCacheIneligibleError(estimated);
            }
            lastErr = e;
            if (i < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
async function listVertexCachedContentNames(pageToken) {
    const project = vertexProjectId();
    const location = vertexLocation();
    const token = await getVertexAccessToken();
    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken)
        params.set('pageToken', pageToken);
    const url = `${vertexOrigin(location)}/v1/projects/${project}/locations/${location}/cachedContents?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `${res.status} ${res.statusText}`);
    return JSON.parse(raw);
}
async function listDeveloperCachedContentNames(apiKey, pageToken) {
    const params = new URLSearchParams({ pageSize: '100', key: apiKey });
    if (pageToken)
        params.set('pageToken', pageToken);
    const url = `${GEMINI_API_BASE}/cachedContents?${params}`;
    const res = await fetch(url);
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `${res.status} ${res.statusText}`);
    return JSON.parse(raw);
}
/** Liệt kê mọi cachedContent trên Google/Vertex (phân trang). */
export async function listAllCachedContentNames(apiKey) {
    const names = [];
    const seen = new Set();
    let pageToken;
    for (let page = 0; page < 50; page++) {
        const data = useVertexGeminiBackend()
            ? await listVertexCachedContentNames(pageToken)
            : await listDeveloperCachedContentNames(apiKey, pageToken);
        for (const item of data.cachedContents ?? []) {
            const name = item.name?.trim();
            if (!name || seen.has(name))
                continue;
            seen.add(name);
            names.push(name);
        }
        pageToken = data.nextPageToken?.trim();
        if (!pageToken)
            break;
    }
    return names;
}
/** Xoá cached content trên Google/Vertex (best-effort). */
export async function deleteCachedContent(apiKey, name) {
    const trimmed = name.trim();
    if (!trimmed)
        return;
    try {
        if (useVertexGeminiBackend()) {
            const location = vertexLocation();
            const token = await getVertexAccessToken();
            const url = `${vertexOrigin(location)}/v1/${trimmed}`;
            await fetch(url, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            return;
        }
        const url = `${GEMINI_API_BASE}/${trimmed}?key=${encodeURIComponent(apiKey)}`;
        await fetch(url, { method: 'DELETE' });
    }
    catch {
        /* ignore */
    }
}
