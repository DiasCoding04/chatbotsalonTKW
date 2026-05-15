import { getVertexAccessToken, useVertexGeminiBackend } from "./vertex-auth.js";
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
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: fullModel,
            systemInstruction: { parts: [{ text: systemPrompt }] },
            ttl: `${ttlSeconds}s`,
        }),
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
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await createCachedContent(apiKey, model, systemPrompt, ttlSeconds);
        }
        catch (e) {
            lastErr = e;
            if (i < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
