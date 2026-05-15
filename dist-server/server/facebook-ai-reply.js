/**
 * Tin khách (webhook) → đọc CONTEXT + hội thoại → Gemini (Vertex hoặc API key) → gửi Messenger.
 * Vertex: cùng biến môi trường như Training — GEMINI_BACKEND=vertex + GOOGLE_APPLICATION_CREDENTIALS
 * (hoặc VERTEX_SERVICE_ACCOUNT_JSON) + VERTEX_AI_PROJECT_ID (+ VERTEX_AI_LOCATION / VERTEX_AI_MODEL).
 */
import { resolveGeminiContextCacheTtlSeconds } from "./context-cache-ttl.js";
import { ensureSharedContextCache, evictSharedContextCacheAndDeleteRemote, } from "./context-cache-store.js";
import { readContextDocument, readImageSamplesDocument } from "./context-store.js";
import { isSalonOutboundAuthor, registerAiOutboundMessageId } from "./facebook-message-author.js";
import { appendOutboundFacebookMessage, applyFacebookConversationAiUsage, readFacebookStoreSnapshot, } from "./facebook-store.js";
import { getServerGeminiApiKey } from "./gemini-api-key.js";
import { getVertexAccessToken, useVertexGeminiBackend } from "./vertex-auth.js";
import { estimateUsd, getTariff } from "../shared/gemini-pricing.js";
import { BRANCH_PAGES, buildSalonSystemPrompt, expandModelImageSampleMarkers, inferBranchForFacebookPage, isSalonPlaceholderMessageText, mergeContextWithImageSampleCatalog, parseImageSampleGroups, } from "../shared/salon-ai-context.js";
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const THINKING_CONFIG = { thinkingBudget: 0 };
const IMAGE_SAMPLES_BASE_URL = process.env.IMAGE_SAMPLES_BASE_URL?.trim() || '';
/** Không import `facebook.ts` (tránh vòng phụ thuộc). */
function parseAllowedMetaImageFetchUrl(raw) {
    try {
        const u = new URL(raw.trim());
        if (u.protocol !== 'https:')
            return null;
        const h = u.hostname.toLowerCase();
        const allowed = h.endsWith('fbcdn.net') ||
            h === 'facebook.com' ||
            h.endsWith('.facebook.com') ||
            h.endsWith('fb.com') ||
            h.endsWith('fbsbx.com');
        return allowed ? u : null;
    }
    catch {
        return null;
    }
}
function modelNeedsExplicitThinkingOff(model) {
    const m = model.toLowerCase();
    return m.includes('gemini-3') || m.includes('/3.');
}
function buildGeminiContentsCachedOnly(history, model, cachedContent) {
    const gen = {
        maxOutputTokens: 768,
        temperature: 0.55,
    };
    if (modelNeedsExplicitThinkingOff(model)) {
        gen.thinkingConfig = { ...THINKING_CONFIG };
    }
    return {
        contents: history.map((h) => ({
            role: h.role,
            parts: h.parts.length ? h.parts : [{ text: '(tin nhắn)' }],
        })),
        generationConfig: gen,
        cachedContent,
    };
}
function vertexLocation() {
    return process.env.VERTEX_AI_LOCATION?.trim() || 'global';
}
function vertexOrigin(location = vertexLocation()) {
    return location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;
}
function vertexGenerateUrl(model) {
    const project = process.env.VERTEX_AI_PROJECT_ID?.trim();
    if (!project)
        throw new Error('Thiếu VERTEX_AI_PROJECT_ID cho Vertex AI.');
    const location = vertexLocation();
    const modelId = process.env.VERTEX_AI_MODEL?.trim() || model.replace(/^models\//, '');
    const origin = vertexOrigin(location);
    return `${origin}/v1/projects/${project}/locations/${location}/publishers/google/models/${modelId}:generateContent`;
}
function developerGenerateUrl(model, apiKey) {
    const fullModel = model.startsWith('models/') ? model : `models/${model}`;
    return `${GEMINI_API_BASE}/${fullModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
}
function looksLikeStaleContextCacheError(message) {
    const m = message.toLowerCase();
    return (m.includes('not found') ||
        m.includes('invalid') ||
        m.includes('expired') ||
        m.includes('cachedcontent') ||
        m.includes('does not exist') ||
        (m.includes('404') && m.includes('cache')) ||
        m.includes('permission_denied'));
}
/** Luôn dùng cachedContent — không gửi lại full systemInstruction (tối ưu chi phí). */
async function generateGeminiTextCachedOnly(model, history, cacheName, maxOut, signal) {
    const name = cacheName.trim();
    if (!name)
        throw new Error('Thiếu cachedContent — bắt buộn dùng Context Cache.');
    const base = buildGeminiContentsCachedOnly(history, model, name);
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
        url = vertexGenerateUrl(model);
        headers.Authorization = `Bearer ${await getVertexAccessToken()}`;
    }
    else {
        const apiKey = getServerGeminiApiKey();
        if (!apiKey)
            throw new Error('Thiếu GEMINI_API_KEY (hoặc bật Vertex: GEMINI_BACKEND=vertex).');
        url = developerGenerateUrl(model, apiKey);
    }
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal,
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
    return { text, usageMetadata: data.usageMetadata };
}
/** AI phải đọc đủ 15 tin có text. Tin chỉ ảnh/file không được tính quota text. */
const FACEBOOK_AI_HISTORY_MAX_TEXT_MESSAGES = 15;
const MAX_IMAGE_BYTES_FOR_GEMINI = 4 * 1024 * 1024;
const MAX_IMAGES_PER_USER_TURN = 8;
const IMAGE_FETCH_TIMEOUT_MS = 22_000;
async function fetchMetaImageAsGeminiPart(url) {
    const parsed = parseAllowedMetaImageFetchUrl(url);
    if (!parsed || url.length > 8000)
        return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(parsed.toString(), {
            redirect: 'follow',
            signal: ctrl.signal,
            headers: {
                Accept: 'image/*,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (compatible; SalonInbox/1.0; +https://developers.facebook.com/)',
            },
        });
        if (!res.ok) {
            console.warn('[facebook-ai] Tải ảnh cho Gemini:', res.status, parsed.hostname);
            return null;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > MAX_IMAGE_BYTES_FOR_GEMINI) {
            console.warn('[facebook-ai] Ảnh quá lớn, bỏ qua:', buf.byteLength);
            return null;
        }
        const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        let mime = ct.startsWith('image/') ? ct : '';
        if (!mime.startsWith('image/')) {
            if (buf[0] === 0xff && buf[1] === 0xd8)
                mime = 'image/jpeg';
            else if (buf[0] === 0x89 && buf[1] === 0x50)
                mime = 'image/png';
            else if (buf[0] === 0x47 && buf[1] === 0x49)
                mime = 'image/gif';
            else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46)
                mime = 'image/webp';
            else
                return null;
        }
        if (mime === 'image/jpg')
            mime = 'image/jpeg';
        const data = Buffer.from(buf).toString('base64');
        return { inlineData: { mimeType: mime, data } };
    }
    catch (e) {
        console.warn('[facebook-ai] Lỗi tải ảnh cho Gemini:', parsed.hostname, e instanceof Error ? e.message : e);
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function hydratePartialTurnsForGemini(partials) {
    const out = [];
    for (const t of partials) {
        if (t.role === 'model') {
            out.push({ role: 'model', parts: [{ text: t.text }] });
            continue;
        }
        const userText = t.text.trim() || '(tin nhắn)';
        const urls = t.attachImagePayload ? t.imageUrls.slice(0, MAX_IMAGES_PER_USER_TURN) : [];
        const imageParts = urls.length > 0
            ? (await Promise.all(urls.map((u) => fetchMetaImageAsGeminiPart(u)))).filter((p) => p != null)
            : [];
        out.push({ role: 'user', parts: [{ text: userText }, ...imageParts] });
    }
    return out;
}
function lastUserTurnPlainText(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h.role !== 'user')
            continue;
        for (const p of h.parts) {
            if ('text' in p && typeof p.text === 'string')
                return p.text;
        }
    }
    return '';
}
function recentUserTurnsPlainText(history, maxTurns = 4) {
    const lines = [];
    for (let i = history.length - 1; i >= 0 && lines.length < maxTurns; i--) {
        const h = history[i];
        if (h.role !== 'user')
            continue;
        for (const p of h.parts) {
            if ('text' in p && typeof p.text === 'string' && p.text.trim()) {
                lines.unshift(p.text.trim());
                break;
            }
        }
    }
    return lines.join('\n');
}
/** Khi model/marker không còn nội dung gửi được — tránh im lặng với khách. */
const FACEBOOK_AI_EMPTY_REPLY_FALLBACK = 'Dạ em nhận tin của chị rồi ạ, em tư vấn lại cho mình ngay nha chị';
/** Mỗi dòng non-empty = 1 tin Messenger riêng (giới hạn độ dài 1 tin). */
function splitAiReplyIntoFacebookMessages(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.slice(0, 1900));
}
const replyChain = new Map();
function enqueueFacebookAiReply(target, deps) {
    const key = target.conversationId;
    const prev = replyChain.get(key) ?? Promise.resolve();
    const next = prev.then(() => executeFacebookAiReply(target, deps));
    replyChain.set(key, next);
    void next.finally(() => {
        if (replyChain.get(key) === next)
            replyChain.delete(key);
    });
}
function storedMessagesToPartialTurns(conv, attachImagesForMessageId) {
    const out = [];
    for (const m of conv.messages) {
        if (m.author === 'customer') {
            const attachImagePayload = m.id === attachImagesForMessageId;
            let t = m.text.trim();
            const imageUrls = [...(m.images ?? [])].filter((u) => typeof u === 'string' && u.trim().length > 0);
            if (isSalonPlaceholderMessageText(t)) {
                const nImg = m.images?.length ?? 0;
                const nVid = m.videos?.length ?? 0;
                const nAud = m.audios?.length ?? 0;
                if (nImg + nVid + nAud > 0) {
                    const bits = [];
                    if (nImg)
                        bits.push(`${nImg} ảnh`);
                    if (nVid)
                        bits.push(`${nVid} video`);
                    if (nAud)
                        bits.push(`${nAud} file ghi âm`);
                    if (nImg > 0 && attachImagePayload) {
                        t = `Khách gửi ${bits.join(', ')}. Ảnh của tin này được đính kèm ngay sau đoạn chữ (pixel cho model đọc).`;
                    }
                    else if (nImg > 0 && !attachImagePayload) {
                        t = `Khách đã gửi ${bits.join(', ')} trong tin này. (Lịch sử chỉ gửi chữ — không gửi lại file ảnh.)`;
                    }
                    else {
                        t = `Khách gửi ${bits.join(', ')}.`;
                    }
                }
                else {
                    continue;
                }
            }
            if (!t && imageUrls.length) {
                t = attachImagePayload
                    ? 'Khách gửi ảnh (không kèm chữ).'
                    : 'Khách đã gửi ảnh (không kèm chữ) trong tin này — không đính kèm lại pixel trong lượt này.';
            }
            if (!t && !imageUrls.length)
                continue;
            out.push({ role: 'user', text: t || '(tin nhắn)', imageUrls, attachImagePayload });
        }
        else if (isSalonOutboundAuthor(m.author)) {
            const t = m.text.trim();
            if (t)
                out.push({ role: 'model', text: t });
        }
    }
    return out;
}
function hasCountableTextMessage(message) {
    const text = message.text.trim();
    if (!text)
        return false;
    if (message.author === 'customer' && isSalonPlaceholderMessageText(text))
        return false;
    return true;
}
function selectAiHistoryMessages(messages, latestCustomerMessageId, maxTextMessages) {
    const picked = [];
    let textQuota = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const isLatestCustomerMessage = m.id === latestCustomerMessageId;
        const countableText = hasCountableTextMessage(m);
        if (!isLatestCustomerMessage && !countableText)
            continue;
        if (!isLatestCustomerMessage && textQuota >= maxTextMessages)
            continue;
        picked.push(m);
        if (countableText)
            textQuota += 1;
    }
    return picked.reverse();
}
function resolveGeminiModelId() {
    const vertex = useVertexGeminiBackend();
    const m = (vertex ? process.env.VERTEX_AI_MODEL : process.env.VITE_GEMINI_MODEL)?.trim();
    return m || 'gemini-3.1-flash-lite';
}
async function executeFacebookAiReply(target, deps) {
    try {
        const store = await readFacebookStoreSnapshot();
        const conv = store.conversations.find((c) => c.id === target.conversationId);
        if (!conv)
            return;
        const page = store.pages.find((p) => p.id === target.pageId);
        if (!page)
            return;
        if (page.aiMasterEnabled === false)
            return;
        if (conv.aiEnabled === false)
            return;
        const last = conv.messages[conv.messages.length - 1];
        if (!last || last.author !== 'customer')
            return;
        const vertex = useVertexGeminiBackend();
        const apiKey = getServerGeminiApiKey();
        if (!vertex && !apiKey) {
            console.warn('[facebook-ai] Bỏ qua: đặt GEMINI_BACKEND=vertex (+ service account) hoặc GEMINI_API_KEY.');
            return;
        }
        const ctxDoc = await readContextDocument();
        const imgDoc = await readImageSamplesDocument();
        const groups = parseImageSampleGroups(imgDoc.content);
        const mergedContext = mergeContextWithImageSampleCatalog(ctxDoc.content, groups);
        const pageIndex = store.pages.findIndex((p) => p.id === target.pageId);
        const inferredBranch = inferBranchForFacebookPage(page, pageIndex >= 0 ? pageIndex : 0);
        const branchPick = conv.branchPageId ?? page.defaultBranchPageId;
        const branch = branchPick != null && BRANCH_PAGES.some((b) => b.id === branchPick)
            ? (BRANCH_PAGES.find((b) => b.id === branchPick) ?? inferredBranch)
            : inferredBranch;
        const systemPrompt = buildSalonSystemPrompt(mergedContext, branch);
        const ttl = resolveGeminiContextCacheTtlSeconds();
        const model = resolveGeminiModelId();
        const msgSlice = selectAiHistoryMessages(conv.messages, last.id, FACEBOOK_AI_HISTORY_MAX_TEXT_MESSAGES);
        const partialHistory = storedMessagesToPartialTurns({ messages: msgSlice }, last.id);
        if (!partialHistory.length || partialHistory[partialHistory.length - 1]?.role !== 'user')
            return;
        const history = await hydratePartialTurnsForGemini(partialHistory);
        if (!history.length || history[history.length - 1]?.role !== 'user')
            return;
        const maxOut = Number(process.env.VITE_MAX_OUTPUT_TOKENS) || 256;
        let raw;
        let lastGenUsage;
        let lastErr;
        for (let attempt = 0; attempt < 4; attempt++) {
            const cache = await ensureSharedContextCache(apiKey, model, systemPrompt, ttl);
            try {
                const gen = await generateGeminiTextCachedOnly(model, history, cache.name, maxOut);
                raw = gen.text;
                lastGenUsage = gen.usageMetadata;
                lastErr = undefined;
                break;
            }
            catch (e) {
                lastErr = e;
                const msg = e instanceof Error ? e.message : String(e);
                if (attempt < 3 && looksLikeStaleContextCacheError(msg)) {
                    await evictSharedContextCacheAndDeleteRemote(apiKey, model, systemPrompt);
                    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
                    continue;
                }
                throw e;
            }
        }
        if (raw == null)
            throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        const recentUserText = recentUserTurnsPlainText(history);
        const expanded = expandModelImageSampleMarkers(raw, groups, recentUserText, {
            inferImageKeysFromModelOnly: true,
            imageBaseUrl: IMAGE_SAMPLES_BASE_URL,
            maxImagesPerGroup: 3,
        });
        let chunks = splitAiReplyIntoFacebookMessages(expanded.apiText.trim());
        const imageUrls = expanded.imageUrls.filter((u) => /^https?:\/\//i.test(u.trim()));
        if (expanded.imageUrls.length > 0 &&
            imageUrls.length === 0 &&
            !IMAGE_SAMPLES_BASE_URL) {
            console.warn('[facebook-ai]', target.conversationId, 'Có marker ảnh nhưng thiếu IMAGE_SAMPLES_BASE_URL — không gửi được ảnh mẫu.');
        }
        if (!chunks.length && !imageUrls.length) {
            console.warn('[facebook-ai]', target.conversationId, 'Model trả lời rỗng sau xử lý marker — dùng tin dự phòng.', { rawPreview: raw.slice(0, 120) });
            chunks = [FACEBOOK_AI_EMPTY_REPLY_FALLBACK];
        }
        const storeNow = await readFacebookStoreSnapshot();
        const convNow = storeNow.conversations.find((c) => c.id === target.conversationId);
        const latestCustomerNow = convNow?.messages
            ? [...convNow.messages].reverse().find((m) => m.author === 'customer')
            : undefined;
        if (!latestCustomerNow || latestCustomerNow.id !== last.id) {
            console.warn('[facebook-ai]', target.conversationId, 'Khách đã gửi tin mới — bỏ gửi lượt AI cũ (không cộng chi phí inbox).');
            return;
        }
        const token = await deps.getPageToken(target.pageId);
        if (!token)
            throw new Error('Không có page token');
        let deliveredCount = 0;
        let gapBeforeNext = false;
        for (let i = 0; i < chunks.length; i++) {
            if (gapBeforeNext)
                await new Promise((r) => setTimeout(r, 150));
            gapBeforeNext = true;
            const piece = chunks[i];
            const r = await deps.graphSendText(token, target.customerPsid, piece);
            if (r.error?.message || !r.message_id) {
                throw new Error(r.error?.message || 'Graph không trả message_id');
            }
            registerAiOutboundMessageId(r.message_id);
            const ts = new Date().toISOString();
            await appendOutboundFacebookMessage({
                pageId: target.pageId,
                customerPsid: target.customerPsid,
                message: {
                    id: r.message_id,
                    author: 'ai',
                    text: piece,
                    timestamp: ts,
                },
            });
            deliveredCount += 1;
        }
        for (const rawImg of imageUrls) {
            if (gapBeforeNext)
                await new Promise((r) => setTimeout(r, 150));
            gapBeforeNext = true;
            const r = await deps.graphSendImageFromUrl(token, target.customerPsid, rawImg);
            if (r.error?.message || !r.message_id) {
                throw new Error(r.error?.message || 'Graph không trả message_id (ảnh)');
            }
            registerAiOutboundMessageId(r.message_id);
            const ts = new Date().toISOString();
            const trimmed = rawImg.trim();
            const storedImg = /^https?:\/\//i.test(trimmed) ? trimmed : `/${trimmed.replace(/^\/+/, '')}`;
            await appendOutboundFacebookMessage({
                pageId: target.pageId,
                customerPsid: target.customerPsid,
                message: {
                    id: r.message_id,
                    author: 'ai',
                    text: '',
                    timestamp: ts,
                    images: [storedImg],
                },
            });
            deliveredCount += 1;
        }
        if (deliveredCount > 0) {
            const tariff = getTariff(model);
            let addUsd = 0;
            let contextCacheHit = false;
            if (tariff && lastGenUsage) {
                const m = lastGenUsage;
                addUsd = estimateUsd(tariff, m.promptTokenCount ?? 0, m.cachedContentTokenCount ?? 0, m.candidatesTokenCount ?? 0).totalUsd;
                contextCacheHit = (m.cachedContentTokenCount ?? 0) > 0;
            }
            await applyFacebookConversationAiUsage({
                conversationId: target.conversationId,
                addUsd,
                contextCacheHit,
            });
        }
        else {
            console.warn('[facebook-ai]', target.conversationId, 'Không gửi được tin nào — không cộng chi phí inbox.');
        }
    }
    catch (e) {
        console.warn('[facebook-ai]', target.conversationId, e);
    }
}
export async function scheduleFacebookAiReplies(targets, deps) {
    if (!targets.length)
        return;
    if (process.env.FACEBOOK_AI_AUTO_REPLY?.trim() === '0')
        return;
    for (const t of targets) {
        enqueueFacebookAiReply(t, deps);
    }
}
