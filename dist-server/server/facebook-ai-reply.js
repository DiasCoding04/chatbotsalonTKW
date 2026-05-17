/**
 * Tin khách (webhook) → đọc CONTEXT + hội thoại → Gemini (Vertex hoặc API key) → gửi Messenger.
 * Vertex: cùng biến môi trường như Training — GEMINI_BACKEND=vertex + GOOGLE_APPLICATION_CREDENTIALS
 * (hoặc VERTEX_SERVICE_ACCOUNT_JSON) + VERTEX_AI_PROJECT_ID (+ VERTEX_AI_LOCATION / VERTEX_AI_MODEL).
 */
import { estimateContextCacheTokens } from "../shared/context-cache-eligibility.js";
import { resolveGeminiContextCacheTtlSeconds } from "./context-cache-ttl.js";
import { ensureSharedContextCache, purgeAllSharedContextCachesRemote, touchContextCacheActivity, } from "./context-cache-store.js";
import { readContextDocument, readImageSamplesDocument } from "./context-store.js";
import { isSalonOutboundAuthor, registerAiOutboundMessageId } from "./facebook-message-author.js";
import { appendOutboundFacebookMessage, applyFacebookConversationAiUsage, markFacebookAiReplyCompleted, readFacebookStoreForConversation, readConversationFromFirestore, getLastCustomerMessage, conversationNeedsAiReply, releaseFacebookAiReplyClaim, tryClaimFacebookAiReply, } from "./facebook-store.js";
import { getServerGeminiApiKey } from "./gemini-api-key.js";
import { getVertexAccessToken, useVertexGeminiBackend } from "./vertex-auth.js";
import { estimateUsd, getTariff } from "../shared/gemini-pricing.js";
import { buildRealtimeContextBlock, buildSalonSystemPromptStatic, conversationAlreadyUsedBlockedScheduleAsk, conversationCustomerHasNamedService, ensureAskServiceLineWhenNeeded, DEFAULT_MAX_IMAGE_SAMPLES_PER_REPLY, expandModelImageSampleMarkers, conversationAlreadyUsedPromoDeadline, filterPrematureScheduleAskLines, filterPromoDeadlineLines, filterRepeatedBlockedScheduleAskLines, inferBranchForFacebookPage, isExplicitImageSampleRequest, isSalonPlaceholderMessageText, mergeContextWithImageSampleCatalog, parseImageSampleGroups, resolveApprovedImageSampleKeys, } from "../shared/salon-ai-context.js";
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const THINKING_CONFIG = { thinkingBudget: 0 };
const IMAGE_SAMPLES_BASE_URL = process.env.IMAGE_SAMPLES_BASE_URL?.trim() || '';
let cachedContextBundle = null;
function getCachedContextBundle(ctxContent, imgContent) {
    if (cachedContextBundle &&
        cachedContextBundle.ctxContent === ctxContent &&
        cachedContextBundle.imgContent === imgContent) {
        return { groups: cachedContextBundle.groups, mergedContext: cachedContextBundle.mergedContext };
    }
    const groups = parseImageSampleGroups(imgContent);
    const mergedContext = mergeContextWithImageSampleCatalog(ctxContent, groups);
    cachedContextBundle = { ctxContent, imgContent, groups, mergedContext };
    return { groups, mergedContext };
}
let cachedSystemPrompt = null;
function getCachedSalonSystemPrompt(mergedContext, branch) {
    const branchKey = `${branch.id}|${branch.name}|${branch.address}|${branch.hotline}`;
    if (cachedSystemPrompt &&
        cachedSystemPrompt.mergedContext === mergedContext &&
        cachedSystemPrompt.branchKey === branchKey) {
        return cachedSystemPrompt.prompt;
    }
    const prompt = buildSalonSystemPromptStatic(mergedContext, branch);
    cachedSystemPrompt = { mergedContext, branchKey, prompt };
    return prompt;
}
/** Không import `facebook.ts` (tránh vòng phụ thuộc). */
function parseAllowedMetaMediaFetchUrl(raw) {
    try {
        const u = new URL(raw.trim());
        if (u.protocol !== 'https:')
            return null;
        const h = u.hostname.toLowerCase();
        const allowed = h.endsWith('fbcdn.net') ||
            h.includes('.fbcdn.') ||
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
/** Voice Messenger thường là .mp4 audioclip trong `videos`, không phải `audios`. */
function isMessengerVoiceClipUrl(url) {
    const u = url.trim();
    if (!u)
        return false;
    if (/\/audioclip[-/]/i.test(u))
        return true;
    return /\.(mp3|aac|m4a|oga|ogg|opus|wav|weba|amr|3gp|caf)($|\?)/i.test(u.split(/[?#]/)[0]);
}
function collectCustomerAudioUrls(message) {
    const out = [];
    for (const u of message.audios ?? []) {
        const t = u.trim();
        if (t)
            out.push(t);
    }
    for (const u of message.videos ?? []) {
        const t = u.trim();
        if (t && isMessengerVoiceClipUrl(t))
            out.push(t);
    }
    return [...new Set(out)];
}
function modelNeedsExplicitThinkingOff(model) {
    const m = model.toLowerCase();
    return m.includes('gemini-3') || m.includes('/3.');
}
function prependRealtimeToGeminiHistory(history) {
    const block = buildRealtimeContextBlock();
    return [
        { role: 'user', parts: [{ text: block }] },
        { role: 'model', parts: [{ text: 'Dạ em đã nắm thời gian và hạn ưu đãi hiện tại ạ.' }] },
        ...history,
    ];
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
async function postGeminiGenerate(model, bodyObj, maxOut, signal) {
    const body = JSON.stringify({
        ...bodyObj,
        generationConfig: {
            ...bodyObj.generationConfig,
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
/** Context Cache (≥4096 token) — không gửi lại systemInstruction. */
async function generateGeminiTextCachedOnly(model, history, cacheName, maxOut, signal) {
    const name = cacheName.trim();
    if (!name)
        throw new Error('Thiếu cachedContent — bắt buộn dùng Context Cache.');
    return postGeminiGenerate(model, buildGeminiContentsCachedOnly(history, model, name), maxOut, signal);
}
/** Fallback khi CONTEXT quá ngắn hoặc Vertex từ chối cache. */
async function generateGeminiTextWithSystemPrompt(model, systemPrompt, history, maxOut, signal) {
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
            parts: h.parts.length ? h.parts : [{ text: '(tin nhắn)' }],
        })),
        generationConfig: gen,
        systemInstruction: { parts: [{ text: systemPrompt }] },
    };
    return postGeminiGenerate(model, body, maxOut, signal);
}
/** AI đọc lại tối đa N tin gần nhất (text + ảnh pixel cho mọi tin khách có ảnh trong cửa sổ). */
const FACEBOOK_AI_HISTORY_MAX_MESSAGES = 20;
const MAX_IMAGE_BYTES_FOR_GEMINI = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES_FOR_GEMINI = 8 * 1024 * 1024;
const MAX_IMAGES_PER_USER_TURN = 8;
const MAX_AUDIOS_PER_USER_TURN = 3;
const MEDIA_FETCH_TIMEOUT_MS = 22_000;
async function fetchMetaMediaBuffer(url, accept, maxBytes, logLabel) {
    const parsed = parseAllowedMetaMediaFetchUrl(url);
    if (!parsed || url.length > 8000)
        return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MEDIA_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(parsed.toString(), {
            redirect: 'follow',
            signal: ctrl.signal,
            headers: {
                Accept: accept,
                'User-Agent': 'Mozilla/5.0 (compatible; SalonInbox/1.0; +https://developers.facebook.com/)',
            },
        });
        if (!res.ok) {
            console.warn(`[facebook-ai] Tải ${logLabel} cho Gemini:`, res.status, parsed.hostname);
            return null;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > maxBytes) {
            console.warn(`[facebook-ai] ${logLabel} quá lớn, bỏ qua:`, buf.byteLength);
            return null;
        }
        const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        return { buf, contentType };
    }
    catch (e) {
        console.warn(`[facebook-ai] Lỗi tải ${logLabel} cho Gemini:`, parsed.hostname, e instanceof Error ? e.message : e);
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchMetaImageAsGeminiPart(url) {
    const fetched = await fetchMetaMediaBuffer(url, 'image/*,*/*;q=0.8', MAX_IMAGE_BYTES_FOR_GEMINI, 'ảnh');
    if (!fetched)
        return null;
    const { buf, contentType: ct } = fetched;
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
function inferAudioMimeType(buf, contentType, url) {
    const ct = contentType.toLowerCase();
    if (ct.startsWith('audio/'))
        return ct === 'audio/jpg' ? 'audio/mpeg' : ct;
    if (ct === 'video/mp4' || ct === 'video/quicktime' || ct === 'application/mp4') {
        return isMessengerVoiceClipUrl(url) ? 'audio/mp4' : 'video/mp4';
    }
    if (ct.startsWith('video/') && isMessengerVoiceClipUrl(url))
        return 'audio/mp4';
    if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)
        return 'audio/mpeg';
    if (buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53)
        return 'audio/ogg';
    if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
        return isMessengerVoiceClipUrl(url) ? 'audio/mp4' : 'video/mp4';
    }
    if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
        const tag = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
        if (tag === 'WAVE')
            return 'audio/wav';
        if (tag === 'WEBP')
            return null;
    }
    if (isMessengerVoiceClipUrl(url))
        return 'audio/mp4';
    return null;
}
async function fetchMetaAudioAsGeminiPart(url) {
    const fetched = await fetchMetaMediaBuffer(url, 'audio/*,video/mp4,video/quicktime,application/octet-stream,*/*;q=0.8', MAX_AUDIO_BYTES_FOR_GEMINI, 'ghi âm');
    if (!fetched)
        return null;
    const mime = inferAudioMimeType(fetched.buf, fetched.contentType, url);
    if (!mime)
        return null;
    const data = Buffer.from(fetched.buf).toString('base64');
    return { inlineData: { mimeType: mime, data } };
}
async function hydratePartialTurnsForGemini(partials) {
    const out = [];
    for (const t of partials) {
        if (t.role === 'model') {
            out.push({ role: 'model', parts: [{ text: t.text }] });
            continue;
        }
        const userText = t.text.trim() || '(tin nhắn)';
        const imageUrls = t.attachImagePayload ? t.imageUrls.slice(0, MAX_IMAGES_PER_USER_TURN) : [];
        const audioUrls = t.attachAudioPayload ? t.audioUrls.slice(0, MAX_AUDIOS_PER_USER_TURN) : [];
        const [imageParts, audioParts] = await Promise.all([
            imageUrls.length > 0
                ? Promise.all(imageUrls.map((u) => fetchMetaImageAsGeminiPart(u)))
                : Promise.resolve([]),
            audioUrls.length > 0
                ? Promise.all(audioUrls.map((u) => fetchMetaAudioAsGeminiPart(u)))
                : Promise.resolve([]),
        ]);
        const mediaParts = [...imageParts, ...audioParts].filter((p) => p != null);
        out.push({ role: 'user', parts: [{ text: userText }, ...mediaParts] });
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
/** Chờ khách ngừng nhắn (mặc định 20s) rồi mới đọc lại tối đa 20 tin gần nhất và trả lời. */
export function resolveFacebookAiReplyDebounceMs() {
    const raw = process.env.FACEBOOK_AI_REPLY_DEBOUNCE_MS?.trim();
    if (raw === '0')
        return 0;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0)
        return n;
    return 20_000;
}
const pendingReplyDebouncers = new Map();
const aiReplyRetryAttempt = new Map();
function resolveAiReplyMaxRetries() {
    const n = Number(process.env.FACEBOOK_AI_REPLY_MAX_RETRIES);
    if (Number.isFinite(n) && n >= 0)
        return Math.min(8, Math.floor(n));
    return 5;
}
function resolveAiReplyRetryDelayMs(attempt) {
    const base = Number(process.env.FACEBOOK_AI_REPLY_RETRY_DELAY_MS);
    const baseMs = Number.isFinite(base) && base > 0 ? base : 12_000;
    return Math.min(90_000, baseMs * (attempt + 1));
}
function clearAiReplyRetry(conversationId) {
    aiReplyRetryAttempt.delete(conversationId);
}
/** Thử lại khi Gemini/Graph lỗi tạm hoặc claim bị giữ — không quét Firestore định kỳ. */
function scheduleAiReplyRetry(target, deps, reason) {
    if (process.env.FACEBOOK_AI_AUTO_REPLY?.trim() === '0')
        return;
    const attempt = aiReplyRetryAttempt.get(target.conversationId) ?? 0;
    const max = resolveAiReplyMaxRetries();
    if (attempt >= max) {
        console.warn('[facebook-ai]', target.conversationId, 'hết lượt thử lại:', reason);
        aiReplyRetryAttempt.delete(target.conversationId);
        return;
    }
    aiReplyRetryAttempt.set(target.conversationId, attempt + 1);
    const delayMs = resolveAiReplyRetryDelayMs(attempt);
    console.log(`[facebook-ai] retry ${target.conversationId} sau ${delayMs}ms (${attempt + 1}/${max}): ${reason}`);
    setTimeout(() => runFacebookAiReplyQueued(target, deps), delayMs);
}
function runFacebookAiReplyQueued(target, deps) {
    const key = target.conversationId;
    const prev = replyChain.get(key) ?? Promise.resolve();
    const next = prev.then(() => executeFacebookAiReply(target, deps));
    replyChain.set(key, next);
    void next.finally(() => {
        if (replyChain.get(key) === next)
            replyChain.delete(key);
    });
}
function enqueueFacebookAiReply(target, deps) {
    const debounceMs = resolveFacebookAiReplyDebounceMs();
    if (debounceMs <= 0) {
        runFacebookAiReplyQueued(target, deps);
        return;
    }
    const key = target.conversationId;
    const existing = pendingReplyDebouncers.get(key);
    if (existing)
        clearTimeout(existing.timer);
    const timer = setTimeout(() => {
        pendingReplyDebouncers.delete(key);
        runFacebookAiReplyQueued(target, deps);
    }, debounceMs);
    pendingReplyDebouncers.set(key, { timer, target, deps });
}
function storedMessagesToPartialTurns(conv) {
    const out = [];
    for (const m of conv.messages) {
        if (m.author === 'customer') {
            let t = m.text.trim();
            const imageUrls = [...(m.images ?? [])].filter((u) => typeof u === 'string' && u.trim().length > 0);
            const audioUrls = collectCustomerAudioUrls(m);
            const attachImagePayload = imageUrls.length > 0;
            const attachAudioPayload = audioUrls.length > 0;
            const nVoice = audioUrls.length;
            const nVid = (m.videos?.length ?? 0) -
                (m.videos ?? []).filter((u) => isMessengerVoiceClipUrl(u)).length;
            if (isSalonPlaceholderMessageText(t)) {
                const nImg = m.images?.length ?? 0;
                const nAud = nVoice;
                if (nImg + nVid + nAud > 0) {
                    const bits = [];
                    if (nImg)
                        bits.push(`${nImg} ảnh`);
                    if (nVid)
                        bits.push(`${nVid} video`);
                    if (nAud)
                        bits.push(`${nAud} file ghi âm`);
                    const hints = [];
                    if (nImg > 0)
                        hints.push('Ảnh đính kèm ngay sau đoạn chữ (pixel cho model đọc)');
                    if (nAud > 0)
                        hints.push('File ghi âm đính kèm ngay sau đoạn chữ (model nghe nội dung)');
                    t =
                        hints.length > 0
                            ? `Khách gửi ${bits.join(', ')}. ${hints.join('. ')}.`
                            : `Khách gửi ${bits.join(', ')}.`;
                }
                else {
                    continue;
                }
            }
            if (!t && imageUrls.length) {
                t = 'Khách gửi ảnh (không kèm chữ).';
            }
            if (!t && audioUrls.length) {
                t = 'Khách gửi tin nhắn thoại (ghi âm). Nghe file âm thanh đính kèm và trả lời theo nội dung khách nói.';
            }
            if (!t && !imageUrls.length && !audioUrls.length)
                continue;
            out.push({
                role: 'user',
                text: t || '(tin nhắn)',
                imageUrls,
                audioUrls,
                attachImagePayload,
                attachAudioPayload,
            });
        }
        else if (isSalonOutboundAuthor(m.author)) {
            const t = m.text.trim();
            if (t)
                out.push({ role: 'model', text: t });
        }
    }
    return out;
}
function selectAiHistoryMessages(messages, maxMessages) {
    if (messages.length <= maxMessages)
        return messages;
    return messages.slice(-maxMessages);
}
function resolveGeminiModelId() {
    const vertex = useVertexGeminiBackend();
    const m = (vertex ? process.env.VERTEX_AI_MODEL : process.env.VITE_GEMINI_MODEL)?.trim();
    return m || 'gemini-3.1-flash-lite';
}
async function executeFacebookAiReply(target, deps) {
    let claimedCustomerMessageId;
    try {
        const loaded = await readFacebookStoreForConversation(target.conversationId, target.pageId);
        if (!loaded)
            return;
        const { conv, page } = loaded;
        if (page.aiMasterEnabled === false)
            return;
        if (conv.aiEnabled === false)
            return;
        const lastCustomer = getLastCustomerMessage(conv);
        if (!lastCustomer)
            return;
        const customerMessageId = lastCustomer.id;
        const claimed = await tryClaimFacebookAiReply(target.conversationId, customerMessageId);
        if (!claimed) {
            console.log('[facebook-ai]', target.conversationId, 'Bỏ qua — đã trả lời hoặc instance khác đang xử lý tin khách', customerMessageId.slice(-12));
            if (conversationNeedsAiReply(conv, page, { minQuietMs: 0 })) {
                scheduleAiReplyRetry(target, deps, 'claim_busy_or_race');
            }
            return;
        }
        claimedCustomerMessageId = customerMessageId;
        const vertex = useVertexGeminiBackend();
        const apiKey = getServerGeminiApiKey();
        if (!vertex && !apiKey) {
            console.warn('[facebook-ai] Bỏ qua: đặt GEMINI_BACKEND=vertex (+ service account) hoặc GEMINI_API_KEY.');
            if (claimedCustomerMessageId) {
                await releaseFacebookAiReplyClaim(target.conversationId, claimedCustomerMessageId);
            }
            return;
        }
        const ctxDoc = await readContextDocument();
        const imgDoc = await readImageSamplesDocument();
        const { groups, mergedContext } = getCachedContextBundle(ctxDoc.content, imgDoc.content);
        const branch = inferBranchForFacebookPage(page, 0);
        const systemPrompt = getCachedSalonSystemPrompt(mergedContext, branch);
        const estCtxTokens = estimateContextCacheTokens(systemPrompt);
        if (estCtxTokens < 4096) {
            console.warn('[facebook-ai]', target.conversationId, `CONTEXT server quá ngắn (~${estCtxTokens} token ước tính) — kiểm tra data/CONTEXT.md trên Cloud Run. Dùng inline, không tạo Vertex cache.`);
        }
        const ttl = resolveGeminiContextCacheTtlSeconds();
        const model = resolveGeminiModelId();
        const msgSlice = selectAiHistoryMessages(conv.messages, FACEBOOK_AI_HISTORY_MAX_MESSAGES);
        const partialHistory = storedMessagesToPartialTurns({ messages: msgSlice });
        if (!partialHistory.length || partialHistory[partialHistory.length - 1]?.role !== 'user') {
            if (claimedCustomerMessageId) {
                await releaseFacebookAiReplyClaim(target.conversationId, claimedCustomerMessageId);
            }
            return;
        }
        const history = prependRealtimeToGeminiHistory(await hydratePartialTurnsForGemini(partialHistory));
        if (!history.length || history[history.length - 1]?.role !== 'user') {
            if (claimedCustomerMessageId) {
                await releaseFacebookAiReplyClaim(target.conversationId, claimedCustomerMessageId);
            }
            return;
        }
        const maxOut = Number(process.env.VITE_MAX_OUTPUT_TOKENS) || 256;
        let raw;
        let lastGenUsage;
        let lastErr;
        for (let attempt = 0; attempt < 4; attempt++) {
            const cache = await ensureSharedContextCache(apiKey, model, systemPrompt, ttl);
            try {
                const gen = cache.mode === 'inline'
                    ? await generateGeminiTextWithSystemPrompt(model, systemPrompt, history, maxOut)
                    : await generateGeminiTextCachedOnly(model, history, cache.name, maxOut);
                raw = gen.text;
                lastGenUsage = gen.usageMetadata;
                lastErr = undefined;
                break;
            }
            catch (e) {
                lastErr = e;
                const msg = e instanceof Error ? e.message : String(e);
                if (attempt < 3 && looksLikeStaleContextCacheError(msg)) {
                    await purgeAllSharedContextCachesRemote(apiKey);
                    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
                    continue;
                }
                throw e;
            }
        }
        if (raw == null)
            throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
        await touchContextCacheActivity();
        const recentUserText = recentUserTurnsPlainText(history);
        const approvedImageKeys = resolveApprovedImageSampleKeys(recentUserText, groups);
        /** `[]` được coi là whitelist rỗng → không key marker nào qua được. Khi khách chỉ «xem mẫu uốn…» nhưng chưa gõ khớp 1 nhóm, vẫn cho phép `[[SEND_IMAGE:key]]` của model làm nguồn duy nhất (giữ inferImageKeysFromModelOnly để không tự bung ảnh). */
        const ambiguousExplicitSampleAsk = approvedImageKeys.length === 0 && isExplicitImageSampleRequest(recentUserText);
        const expanded = expandModelImageSampleMarkers(raw, groups, recentUserText, {
            inferImageKeysFromModelOnly: true,
            enforceCustomerApprovedKeys: ambiguousExplicitSampleAsk ? undefined : approvedImageKeys,
            imageBaseUrl: IMAGE_SAMPLES_BASE_URL,
            maxImagesPerGroup: DEFAULT_MAX_IMAGE_SAMPLES_PER_REPLY,
        });
        let chunks = splitAiReplyIntoFacebookMessages(expanded.apiText.trim());
        const customerHasNamedService = conversationCustomerHasNamedService(conv.messages, (author) => author === 'customer');
        chunks = filterPrematureScheduleAskLines(chunks, customerHasNamedService);
        chunks = ensureAskServiceLineWhenNeeded(chunks, customerHasNamedService);
        const scheduleAskAlreadySent = conversationAlreadyUsedBlockedScheduleAsk(conv.messages, isSalonOutboundAuthor);
        chunks = filterRepeatedBlockedScheduleAskLines(chunks, scheduleAskAlreadySent);
        const promoDeadlineAlreadySent = conversationAlreadyUsedPromoDeadline(conv.messages, isSalonOutboundAuthor);
        chunks = filterPromoDeadlineLines(chunks, promoDeadlineAlreadySent);
        if (scheduleAskAlreadySent && chunks.length === 0 && !expanded.imageUrls.length) {
            chunks = [FACEBOOK_AI_EMPTY_REPLY_FALLBACK];
        }
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
        const convNow = await readConversationFromFirestore(target.conversationId);
        const latestCustomerNow = convNow ? getLastCustomerMessage(convNow) : undefined;
        if (!latestCustomerNow || latestCustomerNow.id !== customerMessageId) {
            console.warn('[facebook-ai]', target.conversationId, 'Khách đã gửi tin mới — bỏ gửi lượt AI cũ (không cộng chi phí inbox).');
            if (claimedCustomerMessageId) {
                await releaseFacebookAiReplyClaim(target.conversationId, claimedCustomerMessageId);
            }
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
            if (claimedCustomerMessageId) {
                await markFacebookAiReplyCompleted(target.conversationId, claimedCustomerMessageId);
                clearAiReplyRetry(target.conversationId);
            }
        }
        else {
            console.warn('[facebook-ai]', target.conversationId, 'Không gửi được tin nào — không cộng chi phí inbox.');
            if (claimedCustomerMessageId) {
                await releaseFacebookAiReplyClaim(target.conversationId, claimedCustomerMessageId);
            }
            scheduleAiReplyRetry(target, deps, 'no_delivery');
        }
    }
    catch (e) {
        console.warn('[facebook-ai]', target.conversationId, e);
        if (claimedCustomerMessageId) {
            await releaseFacebookAiReplyClaim(target.conversationId, claimedCustomerMessageId).catch(() => undefined);
        }
        scheduleAiReplyRetry(target, deps, 'execute_error');
    }
}
/** Lên lịch trả lời AI ngay khi webhook lưu tin khách (debounce gom nhiều tin liên tiếp). */
export function scheduleFacebookAiReplies(targets, deps) {
    if (!targets.length)
        return;
    if (process.env.FACEBOOK_AI_AUTO_REPLY?.trim() === '0')
        return;
    for (const t of targets) {
        clearAiReplyRetry(t.conversationId);
        enqueueFacebookAiReply(t, deps);
    }
}
