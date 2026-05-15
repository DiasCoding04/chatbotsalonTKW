import { getServerGeminiApiKey } from "./gemini-api-key.js";
import { getVertexAccessToken, useVertexGeminiBackend } from "./vertex-auth.js";
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const THINKING_CONFIG = { thinkingBudget: 0 };
function modelNeedsExplicitThinkingOff(model) {
    const m = model.toLowerCase();
    return m.includes('gemini-3') || m.includes('/3.');
}
function buildContents(systemPrompt, history, model, cachedContent) {
    const gen = {
        maxOutputTokens: 768,
        temperature: 0.55,
    };
    if (modelNeedsExplicitThinkingOff(model)) {
        gen.thinkingConfig = { ...THINKING_CONFIG };
    }
    const body = {
        contents: history.map((h) => ({
            role: h.role,
            parts: [{ text: h.text.trim() || '(tin nhắn)' }],
        })),
        generationConfig: gen,
    };
    if (cachedContent) {
        body.cachedContent = cachedContent;
    }
    else if (systemPrompt) {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
    }
    return body;
}
function vertexLocation() {
    return process.env.VERTEX_AI_LOCATION?.trim() || 'global';
}
function vertexOrigin(location = vertexLocation()) {
    return location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;
}
function vertexGeneratePath(model) {
    const project = process.env.VERTEX_AI_PROJECT_ID?.trim();
    if (!project)
        throw new Error('Thiếu VERTEX_AI_PROJECT_ID cho Vertex AI.');
    const location = vertexLocation();
    const modelId = process.env.VERTEX_AI_MODEL?.trim() || model.replace(/^models\//, '');
    const origin = vertexOrigin(location);
    const path = `/v1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:generateContent`;
    return { origin, path };
}
function developerGenerateUrl(model, apiKey) {
    const fullModel = model.startsWith('models/') ? model : `models/${model}`;
    return `${GEMINI_API_BASE}/${fullModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
}
/**
 * generateContent (không stream) — dùng cho inbox AI; cùng body với Training (cachedContent + history).
 */
export async function generateGeminiContent(model, systemPrompt, history, options) {
    const maxOut = options?.maxOutputTokens ?? 256;
    const cachedContent = options?.cachedContent;
    const base = buildContents(systemPrompt, history, model, cachedContent);
    const body = JSON.stringify({
        ...base,
        generationConfig: {
            ...base.generationConfig,
            maxOutputTokens: maxOut,
        },
    });
    let url;
    const headers = { 'Content-Type': 'application/json' };
    if (useVertexGeminiBackend()) {
        const { origin, path } = vertexGeneratePath(model);
        url = `${origin}${path}`;
        headers.Authorization = `Bearer ${await getVertexAccessToken()}`;
    }
    else {
        const apiKey = getServerGeminiApiKey();
        if (!apiKey)
            throw new Error('Thiếu GEMINI_API_KEY trên server (hoặc Vertex chưa bật).');
        url = developerGenerateUrl(model, apiKey);
    }
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: options?.signal,
    });
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `${res.status} ${res.statusText}`);
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        throw new Error(raw.slice(0, 500));
    }
    if (data.error?.message)
        throw new Error(data.error.message);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) {
        const reason = data.candidates?.[0]?.finishReason;
        throw new Error(reason ? `Không có văn bản (${reason})` : 'Không có phản hồi từ model');
    }
    return { text };
}
