import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clearVertexAccessTokenCache, getVertexAccessToken } from "./vertex-auth.js";
import { isStoredAiMessageId, normalizeStoredMessageAuthor, rememberAiMessageId, registerAiOutboundMessageId, } from "./facebook-message-author.js";
import { BRANCH_PAGES, isSalonPlaceholderMessageText, PLACEHOLDER_NO_TEXT, } from "../shared/salon-ai-context.js";
const DATA_DIR = process.env.CONTEXT_DATA_DIR?.trim() || resolve(process.cwd(), 'data');
const FACEBOOK_STORE_FILE = process.env.FACEBOOK_STORE_PATH?.trim() || resolve(DATA_DIR, 'facebook-conversations.json');
const FACEBOOK_STORE_BACKEND = process.env.FACEBOOK_STORE_BACKEND?.trim().toLowerCase() ||
    (process.env.K_SERVICE ? 'firestore' : 'file');
const FIRESTORE_PROJECT_ID = process.env.FACEBOOK_STORE_FIRESTORE_PROJECT_ID?.trim() ||
    process.env.VERTEX_AI_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    '';
const FIRESTORE_DATABASE = process.env.FACEBOOK_STORE_FIRESTORE_DATABASE?.trim() || '(default)';
const FIRESTORE_COLLECTION = process.env.FACEBOOK_STORE_FIRESTORE_COLLECTION?.trim() || 'salon_chat';
const FIRESTORE_DOC_ID = process.env.FACEBOOK_STORE_FIRESTORE_DOC_ID?.trim() || 'facebook_store';
function emptyStore() {
    return { pages: [], conversations: [], updatedAt: new Date().toISOString() };
}
function firestoreDocName() {
    return `projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE}/documents/${FIRESTORE_COLLECTION}/${FIRESTORE_DOC_ID}`;
}
function firestoreDocUrl() {
    return `https://firestore.googleapis.com/v1/${firestoreDocName()}`;
}
async function fetchFirestoreWithAuth(url, init = {}) {
    let token = await getVertexAccessToken();
    let res = await fetch(url, {
        ...init,
        headers: {
            ...init.headers,
            Authorization: `Bearer ${token}`,
        },
    });
    if (res.status !== 401)
        return res;
    clearVertexAccessTokenCache();
    token = await getVertexAccessToken();
    res = await fetch(url, {
        ...init,
        headers: {
            ...init.headers,
            Authorization: `Bearer ${token}`,
        },
    });
    return res;
}
async function readStoreFromFile() {
    try {
        const raw = await readFile(FACEBOOK_STORE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            pages: Array.isArray(parsed.pages) ? parsed.pages : [],
            conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        };
    }
    catch {
        return emptyStore();
    }
}
async function writeStoreToFile(store) {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(FACEBOOK_STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}
async function readStoreFromFirestore() {
    if (!FIRESTORE_PROJECT_ID)
        return null;
    const res = await fetchFirestoreWithAuth(firestoreDocUrl());
    if (res.status === 404)
        return null;
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `Firestore read failed (${res.status})`);
    const doc = JSON.parse(raw);
    const jsonText = doc.fields?.json?.stringValue;
    if (!jsonText)
        return null;
    try {
        return JSON.parse(jsonText);
    }
    catch {
        return null;
    }
}
async function writeStoreToFirestore(store) {
    if (!FIRESTORE_PROJECT_ID)
        throw new Error('Thiếu FIRESTORE project id cho Facebook store.');
    const payload = {
        name: firestoreDocName(),
        fields: {
            json: { stringValue: JSON.stringify(store) },
        },
    };
    const res = await fetchFirestoreWithAuth(firestoreDocUrl(), {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
    });
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `Firestore write failed (${res.status})`);
}
function repairConversationMessageAuthors(conv) {
    let changed = false;
    let ids = [...(conv.aiMessageIds ?? [])];
    for (const m of conv.messages) {
        if (m.author === 'system' || m.author === 'ai')
            ids = rememberAiMessageId(ids, m.id);
    }
    for (const m of conv.messages) {
        if (!ids.includes(m.id))
            continue;
        if (m.author !== 'ai') {
            m.author = 'ai';
            changed = true;
        }
    }
    const prevLen = conv.aiMessageIds?.length ?? 0;
    if (ids.length !== prevLen || ids.some((id, i) => conv.aiMessageIds?.[i] !== id)) {
        conv.aiMessageIds = ids;
        changed = true;
    }
    return changed;
}
function repairStoreMessageAuthors(store) {
    let changed = false;
    for (const conv of store.conversations) {
        if (repairConversationMessageAuthors(conv))
            changed = true;
    }
    return changed;
}
async function readStore() {
    let store;
    if (FACEBOOK_STORE_BACKEND === 'file') {
        store = await readStoreFromFile();
    }
    else {
        try {
            const firestoreStore = await readStoreFromFirestore();
            if (firestoreStore) {
                store = firestoreStore;
            }
            else {
                store = await readStoreFromFile();
                if (store.conversations.length || store.pages.length) {
                    try {
                        await writeStoreToFirestore(store);
                        console.log('[facebook-store] Seeded Firestore from file store.');
                    }
                    catch (e) {
                        console.warn('[facebook-store] Could not seed Firestore from file store:', e);
                    }
                }
            }
        }
        catch (e) {
            console.warn('[facebook-store] Firestore read fallback to file:', e);
            store = await readStoreFromFile();
        }
    }
    if (repairStoreMessageAuthors(store)) {
        store.updatedAt = new Date().toISOString();
        await writeStore(store);
    }
    return store;
}
async function writeStore(store) {
    if (FACEBOOK_STORE_BACKEND === 'file') {
        await writeStoreToFile(store);
        return;
    }
    await writeStoreToFirestore(store);
}
function isoFromMetaTimestamp(timestamp) {
    if (!timestamp)
        return new Date().toISOString();
    return new Date(timestamp).toISOString();
}
function normalizeReferral(referral) {
    if (!referral)
        return undefined;
    const ctx = referral.ads_context_data;
    const ad = {
        source: referral.source,
        type: referral.type,
        adId: referral.ad_id,
        ref: referral.ref,
        refererUri: referral.referer_uri,
        sourceUrl: referral.source_url,
        title: ctx?.ad_title,
        photoUrl: ctx?.photo_url,
        videoUrl: ctx?.video_url,
        postId: ctx?.post_id,
        raw: referral,
    };
    return Object.values(ad).some(Boolean) ? ad : undefined;
}
function mergeAd(current, incoming) {
    if (!incoming)
        return current;
    return { ...current, ...incoming, raw: incoming.raw ?? current?.raw };
}
function isLikelyVideoUrl(url) {
    return /\.(mp4|mov|webm)(\?|$)/i.test(url);
}
function isLikelyAudioUrl(url) {
    return /\.(mp3|aac|m4a|oga|ogg|opus|wav|weba|amr|3gp|caf)($|\?)/i.test(url.split(/[?#]/)[0]);
}
function isFacebookHostedMediaUrl(url) {
    try {
        const u = new URL(url.trim());
        if (u.protocol !== 'https:')
            return false;
        const h = u.hostname.toLowerCase();
        return (h.endsWith('fbcdn.net') ||
            h.includes('.fbcdn.') ||
            h === 'facebook.com' ||
            h.endsWith('.facebook.com') ||
            h.endsWith('fb.com') ||
            h.endsWith('fbsbx.com'));
    }
    catch {
        return false;
    }
}
/** Quét payload đính kèm (giới hạn độ sâu) để bắt URL fbcdn lồng trong object Meta không chuẩn hóa. */
function deepCollectFacebookMediaUrls(node, depth, out) {
    if (depth > 12 || out.size >= 32)
        return;
    if (node == null)
        return;
    if (typeof node === 'string') {
        const s = node.trim();
        if (s.startsWith('https://') && isFacebookHostedMediaUrl(s))
            out.add(s);
        return;
    }
    if (Array.isArray(node)) {
        for (const x of node)
            deepCollectFacebookMediaUrls(x, depth + 1, out);
        return;
    }
    if (typeof node === 'object') {
        for (const v of Object.values(node)) {
            deepCollectFacebookMediaUrls(v, depth + 1, out);
        }
    }
}
/** Lấy mọi URL media phổ biến trong từng phần tử attachments[].payload (Meta không chỉ dùng payload.url). */
function mediaUrlsFromAttachmentPayload(payload) {
    const urls = [];
    const add = (s) => {
        if (typeof s === 'string' && s.trim().startsWith('http'))
            urls.push(s.trim());
    };
    if (!payload || typeof payload !== 'object')
        return urls;
    const p = payload;
    add(p.url);
    add(p.media_url);
    if (Array.isArray(p.elements)) {
        for (const el of p.elements) {
            if (!el || typeof el !== 'object')
                continue;
            const e = el;
            add(e.image_url);
            add(e.item_url);
            const da = e.default_action;
            if (da && typeof da === 'object')
                add(da.url);
        }
    }
    const nested = p.attachment;
    if (nested && typeof nested === 'object') {
        const inner = nested.payload;
        if (inner && typeof inner === 'object') {
            const ip = inner;
            add(ip.url);
        }
    }
    const deep = new Set();
    deepCollectFacebookMediaUrls(payload, 0, deep);
    for (const u of deep)
        urls.push(u);
    return [...new Set(urls)];
}
function extractAttachmentMedia(message) {
    const images = [];
    const videos = [];
    const audios = [];
    const list = message?.attachments;
    if (!Array.isArray(list))
        return { images, videos, audios };
    for (const att of list) {
        const kind = (att.type || '').toLowerCase();
        const urls = mediaUrlsFromAttachmentPayload(att.payload);
        if (urls.length) {
            for (const url of urls) {
                const videoish = kind === 'video' ||
                    kind === 'video_inline' ||
                    (kind === 'file' && isLikelyVideoUrl(url)) ||
                    isLikelyVideoUrl(url);
                const audioish = kind === 'audio' || kind === 'voice' || (isLikelyAudioUrl(url) && !videoish);
                if (videoish)
                    videos.push(url);
                else if (audioish)
                    audios.push(url);
                else
                    images.push(url);
            }
            continue;
        }
        const legacyUrl = typeof att.payload?.url === 'string' ? att.payload.url.trim() : '';
        if (!legacyUrl)
            continue;
        if (kind === 'audio' || kind === 'voice') {
            audios.push(legacyUrl);
            continue;
        }
        if (kind === 'video' || kind === 'video_inline' || (kind === 'file' && isLikelyVideoUrl(legacyUrl)))
            videos.push(legacyUrl);
        else if (kind === 'image' || kind === 'sticker' || kind === 'fallback')
            images.push(legacyUrl);
        else if (kind === 'file' && isLikelyAudioUrl(legacyUrl))
            audios.push(legacyUrl);
        else if (kind === 'file')
            videos.push(legacyUrl);
        else
            images.push(legacyUrl);
    }
    return {
        images: [...new Set(images)],
        videos: [...new Set(videos)],
        audios: [...new Set(audios)],
    };
}
/** Chỉ bỏ qua Graph cho loại không có file tải được; mọi type khác (kể cả rỗng/unknown) vẫn thử. */
const GRAPH_SKIP_ATTACHMENT_TYPES = new Set(['location', 'contact']);
function shouldTryGraphAttachmentFallback(attachments) {
    return attachments.some((att) => !GRAPH_SKIP_ATTACHMENT_TYPES.has((att.type || '').toLowerCase()));
}
function conversationTitle(psid, text, opts) {
    const cleanText = text.trim();
    if (cleanText && !isSalonPlaceholderMessageText(cleanText))
        return cleanText.slice(0, 80);
    const adTitle = opts?.adTitle?.trim();
    if (adTitle)
        return adTitle.slice(0, 80);
    const nImg = opts?.imageCount ?? 0;
    const nVid = opts?.videoCount ?? 0;
    const nAud = opts?.audioCount ?? 0;
    if (nImg + nVid + nAud > 0)
        return `Ảnh / file · ${psid.slice(-6)}`;
    if (cleanText)
        return cleanText.slice(0, 80);
    return `Khách ${psid.slice(-6)}`;
}
function upsertConversation(store, pageId, customerPsid, timestamp, customerProfile) {
    const id = `${pageId}:${customerPsid}`;
    let conversation = store.conversations.find((item) => item.id === id);
    if (!conversation) {
        conversation = {
            id,
            pageId,
            customerPsid,
            title: `Khách ${customerPsid.slice(-6)}`,
            updatedAt: timestamp,
            lastMessageAt: timestamp,
            messages: [],
        };
        store.conversations.unshift(conversation);
    }
    if (customerProfile?.name)
        conversation.customerName = customerProfile.name;
    if (customerProfile?.avatarUrl)
        conversation.avatarUrl = customerProfile.avatarUrl;
    conversation.updatedAt = timestamp;
    conversation.lastMessageAt = timestamp;
    return conversation;
}
export async function listFacebookConversations() {
    const store = await readStore();
    return {
        ...store,
        conversations: [...store.conversations].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
    };
}
/** Đọc store thô (cho AI inbox — không sort). */
export async function readFacebookStoreSnapshot() {
    return readStore();
}
/** Hội thoại tin cuối từ khách, AI bật — cần bot trả lời. */
export function listUnrepliedFacebookAiTargets(store) {
    const pagesById = new Map(store.pages.map((p) => [p.id, p]));
    const out = [];
    for (const conv of store.conversations) {
        if (conv.aiEnabled === false)
            continue;
        const page = pagesById.get(conv.pageId);
        if (!page || page.aiMasterEnabled === false)
            continue;
        const last = conv.messages[conv.messages.length - 1];
        if (!last || last.author !== 'customer')
            continue;
        out.push({
            conversationId: conv.id,
            pageId: conv.pageId,
            customerPsid: conv.customerPsid,
        });
    }
    return out;
}
const BRANCH_IDS = new Set(BRANCH_PAGES.map((b) => b.id));
export async function patchFacebookConversation(conversationId, patch) {
    const store = await readStore();
    const conv = store.conversations.find((c) => c.id === conversationId);
    if (!conv)
        return false;
    if (typeof patch.aiEnabled === 'boolean') {
        conv.aiEnabled = patch.aiEnabled;
    }
    if ('branchPageId' in patch) {
        if (patch.branchPageId == null) {
            delete conv.branchPageId;
        }
        else if (typeof patch.branchPageId === 'number' && BRANCH_IDS.has(patch.branchPageId)) {
            conv.branchPageId = patch.branchPageId;
        }
        else {
            return false;
        }
    }
    store.updatedAt = new Date().toISOString();
    await writeStore(store);
    return true;
}
export async function patchFacebookPage(pageId, patch) {
    const store = await readStore();
    const page = store.pages.find((p) => p.id === pageId);
    if (!page)
        return null;
    if (typeof patch.aiMasterEnabled === 'boolean') {
        page.aiMasterEnabled = patch.aiMasterEnabled;
    }
    if ('defaultBranchPageId' in patch) {
        if (patch.defaultBranchPageId == null) {
            delete page.defaultBranchPageId;
        }
        else if (typeof patch.defaultBranchPageId === 'number' && BRANCH_IDS.has(patch.defaultBranchPageId)) {
            page.defaultBranchPageId = patch.defaultBranchPageId;
        }
        else {
            return null;
        }
    }
    store.updatedAt = new Date().toISOString();
    await writeStore(store);
    return page;
}
/** Cộng dồn chi phí ước tính và ghi nhận cache hit cho lần gọi Gemini gần nhất. */
export async function applyFacebookConversationAiUsage(input) {
    const store = await readStore();
    const conv = store.conversations.find((c) => c.id === input.conversationId);
    if (!conv)
        return;
    const prev = conv.aiEstimatedTotalUsd ?? 0;
    conv.aiEstimatedTotalUsd = prev + Math.max(0, input.addUsd);
    conv.aiLastContextCacheHit = input.contextCacheHit;
    conv.aiLastRunAt = new Date().toISOString();
    store.updatedAt = new Date().toISOString();
    await writeStore(store);
}
export async function saveFacebookPages(pages) {
    const store = await readStore();
    const merged = new Map(store.pages.map((page) => [page.id, page]));
    for (const page of pages) {
        const prev = merged.get(page.id);
        merged.set(page.id, {
            ...(prev ?? {}),
            id: page.id,
            name: page.name,
            avatarUrl: page.avatarUrl,
            connected: true,
            defaultBranchPageId: prev?.defaultBranchPageId,
            aiMasterEnabled: prev?.aiMasterEnabled,
        });
    }
    store.pages = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    store.updatedAt = new Date().toISOString();
    await writeStore(store);
    return store.pages;
}
export async function enrichFacebookConversationProfiles(resolveCustomerProfile, options) {
    const store = await readStore();
    const maxPerRun = options?.maxPerRun ?? Number.POSITIVE_INFINITY;
    const concurrency = Math.max(1, Math.min(options?.concurrency ?? 4, 8));
    const pending = store.conversations.filter((c) => !c.customerName || !c.avatarUrl).slice(0, maxPerRun);
    if (!pending.length)
        return 0;
    let updated = 0;
    for (let i = 0; i < pending.length; i += concurrency) {
        const chunk = pending.slice(i, i + concurrency);
        await Promise.all(chunk.map(async (conversation) => {
            const profile = await resolveCustomerProfile(conversation.pageId, conversation.customerPsid).catch(() => null);
            if (!profile?.name && !profile?.avatarUrl)
                return;
            if (profile.name && profile.name !== conversation.customerName) {
                conversation.customerName = profile.name;
                updated += 1;
            }
            if (profile.avatarUrl && profile.avatarUrl !== conversation.avatarUrl) {
                conversation.avatarUrl = profile.avatarUrl;
                updated += 1;
            }
        }));
    }
    if (updated) {
        store.updatedAt = new Date().toISOString();
        await writeStore(store);
    }
    return updated;
}
export async function ingestFacebookWebhookPayload(payload, options) {
    const body = payload;
    const entries = Array.isArray(body.entry) ? body.entry : [];
    const store = await readStore();
    let conversationsTouched = 0;
    let messagesStored = 0;
    const pendingAiReplies = [];
    for (const entry of entries) {
        const pageId = entry.id;
        if (!pageId || !Array.isArray(entry.messaging))
            continue;
        if (!store.pages.some((page) => page.id === pageId)) {
            store.pages.push({ id: pageId, name: `Fanpage ${pageId}`, connected: true });
        }
        for (const event of entry.messaging) {
            const senderId = event.sender?.id;
            const recipientId = event.recipient?.id;
            const timestamp = isoFromMetaTimestamp(event.timestamp);
            if (!senderId || !recipientId)
                continue;
            if (event.read || event.delivery) {
                const customerPsid = senderId === pageId ? recipientId : senderId;
                const profile = await options?.resolveCustomerProfile?.(pageId, customerPsid).catch(() => null);
                const conversation = upsertConversation(store, pageId, customerPsid, timestamp, profile);
                if (event.read?.watermark)
                    conversation.customerReadAt = isoFromMetaTimestamp(event.read.watermark);
                if (event.delivery?.watermark)
                    conversation.pageDeliveredAt = isoFromMetaTimestamp(event.delivery.watermark);
                conversationsTouched += 1;
                continue;
            }
            const message = event.message;
            const postback = event.postback;
            if (!message && !postback && !event.referral)
                continue;
            const isEcho = Boolean(message?.is_echo);
            const customerPsid = senderId === pageId ? recipientId : senderId;
            const profile = await options?.resolveCustomerProfile?.(pageId, customerPsid).catch(() => null);
            const conversation = upsertConversation(store, pageId, customerPsid, timestamp, profile);
            const outboundMid = message?.mid?.trim() || postback?.mid?.trim();
            const isOutbound = senderId === pageId || isEcho;
            const author = isOutbound
                ? isStoredAiMessageId(conversation.aiMessageIds, outboundMid)
                    ? 'ai'
                    : 'staff'
                : 'customer';
            let { images: attImages, videos: attVideos, audios: attAudios } = extractAttachmentMedia(message);
            const mid = message?.mid?.trim();
            const attList = message?.attachments;
            if (options?.fetchAttachmentMediaFromGraph &&
                mid &&
                Array.isArray(attList) &&
                attList.length > 0 &&
                attImages.length === 0 &&
                attVideos.length === 0 &&
                attAudios.length === 0 &&
                shouldTryGraphAttachmentFallback(attList)) {
                const fromGraph = await options.fetchAttachmentMediaFromGraph(pageId, mid).catch(() => ({
                    images: [],
                    videos: [],
                    audios: [],
                }));
                attImages = [...new Set([...attImages, ...fromGraph.images])];
                attVideos = [...new Set([...attVideos, ...fromGraph.videos])];
                attAudios = [...new Set([...attAudios, ...fromGraph.audios])];
            }
            const referral = normalizeReferral(message?.referral ?? postback?.referral ?? event.referral);
            let text = message?.text?.trim() ||
                postback?.title?.trim() ||
                postback?.payload?.trim() ||
                '';
            if (!text) {
                if (referral?.title || referral?.photoUrl || referral?.videoUrl || referral?.adId)
                    text = '';
                else if (attImages.length || attVideos.length || attAudios.length)
                    text = '';
                else if (event.referral)
                    text = '';
                else
                    text = PLACEHOLDER_NO_TEXT;
            }
            const id = message?.mid ||
                postback?.mid ||
                `${pageId}-${customerPsid}-${event.timestamp ?? Date.now()}-${conversation.messages.length}`;
            conversation.ad = mergeAd(conversation.ad, referral);
            conversation.title = conversationTitle(customerPsid, text, {
                imageCount: attImages.length,
                videoCount: attVideos.length,
                audioCount: attAudios.length,
                adTitle: conversation.ad?.title,
            });
            const existingMsg = conversation.messages.find((item) => item.id === id);
            if (!existingMsg) {
                conversation.messages.push({
                    id,
                    author,
                    text,
                    timestamp,
                    isEcho,
                    referral,
                    ...(attImages.length ? { images: attImages } : {}),
                    ...(attVideos.length ? { videos: attVideos } : {}),
                    ...(attAudios.length ? { audios: attAudios } : {}),
                });
                messagesStored += 1;
                if (author === 'customer' && !isEcho) {
                    pendingAiReplies.push({
                        conversationId: conversation.id,
                        pageId,
                        customerPsid,
                    });
                }
            }
            else if (isStoredAiMessageId(conversation.aiMessageIds, id)) {
                if (normalizeStoredMessageAuthor(existingMsg.author, existingMsg.id) !== 'ai') {
                    existingMsg.author = 'ai';
                }
            }
            conversationsTouched += 1;
        }
    }
    if (conversationsTouched || messagesStored) {
        store.updatedAt = new Date().toISOString();
        await writeStore(store);
    }
    const dedupedPending = [...new Map(pendingAiReplies.map((p) => [p.conversationId, p])).values()];
    return { conversationsTouched, messagesStored, pendingAiReplies: dedupedPending };
}
/** Ghi tin page gửi đi sau Graph thành công; echo webhook trùng `id` sẽ không thêm bản sao. */
export async function appendOutboundFacebookMessage(input) {
    const store = await readStore();
    const convId = `${input.pageId}:${input.customerPsid}`;
    let conv = store.conversations.find((c) => c.id === convId);
    if (!conv) {
        conv = {
            id: convId,
            pageId: input.pageId,
            customerPsid: input.customerPsid,
            title: `Khách ${input.customerPsid.slice(-6)}`,
            updatedAt: input.message.timestamp,
            lastMessageAt: input.message.timestamp,
            messages: [],
        };
        store.conversations.unshift(conv);
    }
    const normalizedAuthor = normalizeStoredMessageAuthor(input.message.author, input.message.id);
    if (normalizedAuthor === 'ai') {
        registerAiOutboundMessageId(input.message.id);
        conv.aiMessageIds = rememberAiMessageId(conv.aiMessageIds, input.message.id);
    }
    const existing = conv.messages.find((m) => m.id === input.message.id);
    if (existing) {
        if (normalizedAuthor === 'ai')
            existing.author = 'ai';
    }
    else {
        conv.messages.push({ ...input.message, author: normalizedAuthor });
    }
    conv.lastMessageAt = input.message.timestamp;
    conv.updatedAt = input.message.timestamp;
    store.updatedAt = new Date().toISOString();
    await writeStore(store);
}
