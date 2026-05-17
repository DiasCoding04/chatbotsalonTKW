import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clearVertexAccessTokenCache, getVertexAccessToken } from "./vertex-auth.js";
import { isSalonOutboundAuthor, isStoredAiMessageId, normalizeStoredMessageAuthor, rememberAiMessageId, registerAiOutboundMessageId, } from "./facebook-message-author.js";
import { BRANCH_PAGES, isSalonPlaceholderMessageText, PLACEHOLDER_NO_TEXT, } from "../shared/salon-ai-context.js";
import { catalogTapDisplayLine, messengerCatalogInviteFromCustomerText, parseCatalogPayload, sendMessengerCatalogChildMenu, sendMessengerCatalogParentMenu, sendMessengerCatalogSampleImages, } from "./messenger-image-catalog.js";
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
/** Subcollection bên dưới `.../{collection}/{docId}/` — mỗi hội thoại một document (tránh vượt 1 MiB/doc). */
const FIRESTORE_CONVERSATIONS_SUBCOLLECTION = process.env.FACEBOOK_STORE_FIRESTORE_CONVERSATIONS_SUBCOL?.trim() || 'conversations';
const FACEBOOK_STORE_SCHEMA_V2 = 2;
const FIRESTORE_COMMIT_CHUNK = 450;
function resolveMaxMessagesPersist() {
    const raw = process.env.FACEBOOK_STORE_MAX_MESSAGES?.trim()?.toLowerCase();
    if (raw === 'unlimited' || raw === '-1')
        return 0;
    const n = Number(process.env.FACEBOOK_STORE_MAX_MESSAGES?.trim());
    if (Number.isFinite(n) && n > 0)
        return Math.min(50_000, Math.floor(n));
    return 1200;
}
const FACEBOOK_STORE_MAX_MESSAGES = resolveMaxMessagesPersist();
function resolveInboxApiMaxMessages() {
    const raw = process.env.FACEBOOK_INBOX_API_MAX_MESSAGES?.trim()?.toLowerCase();
    if (raw === 'unlimited' || raw === '-1')
        return 0;
    const n = Number(process.env.FACEBOOK_INBOX_API_MAX_MESSAGES?.trim());
    if (Number.isFinite(n) && n > 0)
        return Math.min(500, Math.floor(n));
    return 12;
}
/** Số hội thoại tối đa trong một lần poll inbox (đã sort mới nhất trước). */
function resolveInboxApiMaxConversations() {
    const raw = process.env.FACEBOOK_INBOX_API_MAX_CONVERSATIONS?.trim()?.toLowerCase();
    if (raw === 'unlimited' || raw === '-1')
        return 0;
    const n = Number(process.env.FACEBOOK_INBOX_API_MAX_CONVERSATIONS?.trim());
    if (Number.isFinite(n) && n > 0)
        return Math.min(500, Math.floor(n));
    return 100;
}
/** Tin nhắn gửi kèm mỗi hội thoại không đang mở (chỉ preview — không kèm URL ảnh/video). */
function resolveInboxApiListPreviewMessages() {
    const n = Number(process.env.FACEBOOK_INBOX_API_LIST_PREVIEW_MESSAGES?.trim());
    if (Number.isFinite(n) && n >= 0)
        return Math.min(30, Math.floor(n));
    return 3;
}
const FACEBOOK_INBOX_API_MAX_MESSAGES = resolveInboxApiMaxMessages();
const FACEBOOK_INBOX_API_MAX_CONVERSATIONS = resolveInboxApiMaxConversations();
const FACEBOOK_INBOX_API_LIST_PREVIEW_MESSAGES = resolveInboxApiListPreviewMessages();
function emptyStore() {
    return { pages: [], conversations: [], updatedAt: new Date().toISOString() };
}
const CONV_CLOCKS_MAX_KEYS = 2500;
function firestoreDocName() {
    return `projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE}/documents/${FIRESTORE_COLLECTION}/${FIRESTORE_DOC_ID}`;
}
function firestoreDocUrl() {
    return `https://firestore.googleapis.com/v1/${firestoreDocName()}`;
}
function firestoreConversationsCollectionUrl() {
    return `https://firestore.googleapis.com/v1/${firestoreDocName()}/${FIRESTORE_CONVERSATIONS_SUBCOLLECTION}`;
}
function firestoreCommitEndpoint() {
    return `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DATABASE}/documents:commit`;
}
function serializeConversationForPersist(conv) {
    const max = FACEBOOK_STORE_MAX_MESSAGES;
    const messages = max > 0 && conv.messages.length > max ? conv.messages.slice(-max) : [...conv.messages];
    return JSON.stringify({ ...conv, messages });
}
function firestoreRootCommitWrite(pages, updatedAt) {
    return {
        update: {
            name: firestoreDocName(),
            fields: {
                schemaVersion: { integerValue: String(FACEBOOK_STORE_SCHEMA_V2) },
                pagesJson: { stringValue: JSON.stringify(pages) },
                updatedAt: { stringValue: updatedAt },
            },
        },
        updateMask: { fieldPaths: ['schemaVersion', 'pagesJson', 'updatedAt'] },
    };
}
function parseConvClocksJson(raw) {
    if (!raw?.trim())
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        const out = {};
        for (const [id, ts] of Object.entries(parsed)) {
            if (typeof id === 'string' && typeof ts === 'string' && ts.trim())
                out[id] = ts;
        }
        return out;
    }
    catch {
        return {};
    }
}
function buildConvClocksFromConversations(conversations) {
    const out = {};
    for (const c of conversations) {
        out[c.id] = c.lastMessageAt || c.updatedAt;
    }
    return pruneConvClocks(out);
}
function pruneConvClocks(clocks) {
    const keys = Object.keys(clocks);
    if (keys.length <= CONV_CLOCKS_MAX_KEYS)
        return clocks;
    const sorted = keys.sort((a, b) => clocks[b].localeCompare(clocks[a]));
    const out = {};
    for (const id of sorted.slice(0, CONV_CLOCKS_MAX_KEYS))
        out[id] = clocks[id];
    return out;
}
function mergeConvClocks(base, conversations) {
    const next = { ...base };
    for (const c of conversations) {
        next[c.id] = c.lastMessageAt || c.updatedAt;
    }
    return pruneConvClocks(next);
}
function diffConvClocks(server, client) {
    const changedIds = [];
    for (const [id, ts] of Object.entries(server)) {
        if (client[id] !== ts)
            changedIds.push(id);
    }
    const removedIds = Object.keys(client).filter((id) => !(id in server));
    return { changedIds, removedIds };
}
let convClocksMem = null;
async function loadConvClocksMem() {
    if (convClocksMem)
        return { ...convClocksMem };
    const meta = await readFirestoreRootInboxMeta();
    convClocksMem = meta?.convClocks ?? {};
    return { ...convClocksMem };
}
/** Bump root `updatedAt` (+ optional clocks/pages) — inbox poll `?since=` / delta. */
function firestoreRootRevisionWrite(updatedAt, opts) {
    const fieldPaths = ['updatedAt'];
    const fields = {
        updatedAt: { stringValue: updatedAt },
    };
    if (opts?.convClocks) {
        fields.convClocksJson = { stringValue: JSON.stringify(opts.convClocks) };
        fieldPaths.push('convClocksJson');
    }
    if (opts?.pages) {
        fields.schemaVersion = { integerValue: String(FACEBOOK_STORE_SCHEMA_V2) };
        fields.pagesJson = { stringValue: JSON.stringify(opts.pages) };
        fieldPaths.push('schemaVersion', 'pagesJson');
    }
    return {
        update: { name: firestoreDocName(), fields },
        updateMask: { fieldPaths },
    };
}
/** @deprecated — dùng firestoreRootRevisionWrite */
function firestoreRootUpdatedAtWrite(updatedAt) {
    return firestoreRootRevisionWrite(updatedAt);
}
async function readFirestoreRootInboxMeta() {
    const fields = await readFirestoreRootFields();
    if (!fields)
        return null;
    let pages = [];
    if (fields.pagesJson?.stringValue) {
        try {
            const parsed = JSON.parse(fields.pagesJson.stringValue);
            pages = Array.isArray(parsed) ? parsed : [];
        }
        catch {
            pages = [];
        }
    }
    return {
        updatedAt: fields.updatedAt?.stringValue || new Date().toISOString(),
        pages,
        convClocks: parseConvClocksJson(fields.convClocksJson?.stringValue),
    };
}
function resolveStoreReadCacheMs() {
    const raw = process.env.FACEBOOK_STORE_READ_CACHE_MS?.trim();
    if (raw === '0')
        return 0;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0)
        return n;
    return 30_000;
}
let storeReadMemCache = null;
/** Các request đồng thời dùng chung một promise đọc Firestore — giảm "sóng" khi inbox/sweep chồng nhau. */
let storeReadInFlightPromise = null;
function invalidateStoreReadCache() {
    storeReadMemCache = null;
    pagesMemCache = null;
    convClocksMem = null;
}
let pagesMemCache = null;
function parseConversationFromFirestoreFields(fields) {
    const j = fields.json?.stringValue;
    if (!j)
        return null;
    try {
        const conv = JSON.parse(j);
        repairConversationMessageAuthors(conv);
        return conv;
    }
    catch {
        return null;
    }
}
async function readFirestoreRootFields() {
    if (!FIRESTORE_PROJECT_ID)
        return null;
    const res = await fetchFirestoreWithAuth(firestoreDocUrl());
    if (res.status === 404)
        return null;
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `Firestore read failed (${res.status})`);
    const doc = JSON.parse(raw);
    return doc.fields ?? null;
}
async function readFacebookPagesCached() {
    const ttl = resolveStoreReadCacheMs();
    if (ttl > 0 && pagesMemCache && Date.now() - pagesMemCache.at < ttl) {
        return { pages: pagesMemCache.pages, updatedAt: pagesMemCache.updatedAt };
    }
    if (ttl > 0 && storeReadMemCache && Date.now() - storeReadMemCache.at < ttl) {
        const s = storeReadMemCache.store;
        pagesMemCache = { pages: s.pages, updatedAt: s.updatedAt, at: storeReadMemCache.at };
        return { pages: s.pages, updatedAt: s.updatedAt };
    }
    const fields = await readFirestoreRootFields();
    let pages = [];
    const updatedAt = fields?.updatedAt?.stringValue || new Date().toISOString();
    if (fields?.pagesJson?.stringValue) {
        try {
            const parsed = JSON.parse(fields.pagesJson.stringValue);
            pages = Array.isArray(parsed) ? parsed : [];
        }
        catch {
            pages = [];
        }
    }
    pagesMemCache = { pages, updatedAt, at: Date.now() };
    return { pages, updatedAt };
}
export async function readConversationFromFirestore(conversationId) {
    if (!FIRESTORE_PROJECT_ID)
        return null;
    const res = await fetchFirestoreWithAuth(firestoreConversationDocUrl(conversationId));
    if (res.status === 404)
        return null;
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `Firestore get conversation failed (${res.status})`);
    const doc = JSON.parse(raw);
    if (!doc.fields)
        return null;
    return parseConversationFromFirestoreFields(doc.fields);
}
/** Cập nhật cache RAM sau ghi vài hội thoại — tránh poll inbox phải list toàn bộ subcollection. */
function patchStoreReadMemCacheAfterPartialWrite(pages, updatedAt, dirtyConversations) {
    const ttl = resolveStoreReadCacheMs();
    if (ttl <= 0 || !dirtyConversations.length) {
        invalidateStoreReadCache();
        return;
    }
    if (!storeReadMemCache) {
        pagesMemCache = { pages, updatedAt, at: Date.now() };
        return;
    }
    const cached = storeReadMemCache.store;
    cached.pages = pages;
    cached.updatedAt = updatedAt;
    for (const conv of dirtyConversations) {
        const idx = cached.conversations.findIndex((c) => c.id === conv.id);
        if (idx >= 0)
            cached.conversations[idx] = conv;
        else
            cached.conversations.unshift(conv);
    }
    storeReadMemCache = { store: cached, at: Date.now() };
    pagesMemCache = { pages, updatedAt, at: Date.now() };
    convClocksMem = mergeConvClocks(convClocksMem ?? {}, dirtyConversations);
}
function useFirestoreFacebookStore() {
    return FACEBOOK_STORE_BACKEND === 'firestore' && Boolean(FIRESTORE_PROJECT_ID);
}
async function readStoreRootUpdatedAtFromFirestore() {
    if (!FIRESTORE_PROJECT_ID)
        return null;
    const res = await fetchFirestoreWithAuth(firestoreDocUrl());
    if (res.status === 404)
        return null;
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `Firestore read failed (${res.status})`);
    const doc = JSON.parse(raw);
    return doc.fields?.updatedAt?.stringValue?.trim() || null;
}
function firestoreConversationCommitWrite(conversationId, jsonPayload) {
    return {
        update: {
            name: `${firestoreDocName()}/${FIRESTORE_CONVERSATIONS_SUBCOLLECTION}/${conversationId}`,
            fields: {
                json: { stringValue: jsonPayload },
            },
        },
        updateMask: { fieldPaths: ['json'] },
    };
}
async function firestoreCommit(writes) {
    if (!writes.length)
        return;
    for (let i = 0; i < writes.length; i += FIRESTORE_COMMIT_CHUNK) {
        const chunk = writes.slice(i, i + FIRESTORE_COMMIT_CHUNK);
        const res = await fetchFirestoreWithAuth(firestoreCommitEndpoint(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ writes: chunk }),
        });
        const raw = await res.text();
        if (!res.ok)
            throw new Error(raw || `Firestore commit failed (${res.status})`);
    }
}
async function listAllConversationsFromFirestore() {
    const out = [];
    let pageToken = '';
    for (;;) {
        const url = `${firestoreConversationsCollectionUrl()}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const res = await fetchFirestoreWithAuth(url);
        const raw = await res.text();
        if (!res.ok)
            throw new Error(raw || `Firestore list conversations failed (${res.status})`);
        const parsed = JSON.parse(raw);
        for (const d of parsed.documents ?? []) {
            const j = d.fields?.json?.stringValue;
            if (!j)
                continue;
            try {
                const conv = JSON.parse(j);
                repairConversationMessageAuthors(conv);
                out.push(conv);
            }
            catch {
                /* bỏ qua bản ghi hỏng */
            }
        }
        pageToken = parsed.nextPageToken ?? '';
        if (!pageToken)
            break;
    }
    return out;
}
async function readV2StoreFromRootFields(fields) {
    let pages = [];
    try {
        const parsed = JSON.parse(fields.pagesJson?.stringValue || '[]');
        pages = Array.isArray(parsed) ? parsed : [];
    }
    catch {
        pages = [];
    }
    const updatedAt = fields.updatedAt?.stringValue || new Date().toISOString();
    const conversations = await listAllConversationsFromFirestore();
    return { pages, conversations, updatedAt };
}
async function tryReadFirestoreSubcollectionsOnly() {
    try {
        const conversations = await listAllConversationsFromFirestore();
        if (!conversations.length)
            return null;
        console.warn('[facebook-store] Root document thiếu nhưng vẫn có conversation subdocuments — pages=[] tạm thời.');
        return {
            pages: [],
            conversations,
            updatedAt: new Date().toISOString(),
        };
    }
    catch {
        return null;
    }
}
async function migrateLegacyFirestoreToV2(store) {
    const convWrites = store.conversations.map((c) => firestoreConversationCommitWrite(c.id, serializeConversationForPersist(c)));
    await firestoreCommit(convWrites);
    const del = await fetchFirestoreWithAuth(firestoreDocUrl(), { method: 'DELETE' });
    if (!del.ok && del.status !== 404) {
        const t = await del.text();
        throw new Error(t || `Firestore delete legacy root failed (${del.status})`);
    }
    const payload = {
        name: firestoreDocName(),
        fields: {
            schemaVersion: { integerValue: String(FACEBOOK_STORE_SCHEMA_V2) },
            pagesJson: { stringValue: JSON.stringify(store.pages) },
            updatedAt: { stringValue: store.updatedAt },
        },
    };
    const res = await fetchFirestoreWithAuth(firestoreDocUrl(), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
    });
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `Firestore create v2 root failed (${res.status})`);
    console.log(`[facebook-store] Migration xong: ${store.conversations.length} hội thoại trong subcollection "${FIRESTORE_CONVERSATIONS_SUBCOLLECTION}".`);
}
async function writeStoreToFirestoreV2(store, opts) {
    if (!FIRESTORE_PROJECT_ID)
        throw new Error('Thiếu FIRESTORE project id cho Facebook store.');
    const dirty = opts?.dirtyConversationIds;
    /** Chỉ ghi pagesJson khi PATCH fanpage / sync — tránh webhook ghi đè cài đặt chi nhánh + AI master. */
    const writePagesRoot = opts?.writePagesRoot === true || (opts?.writePagesRoot !== false && dirty === undefined);
    const convIds = dirty === undefined ? store.conversations.map((c) => c.id) : [...dirty];
    const writes = [];
    const dirtyList = convIds
        .map((id) => store.conversations.find((c) => c.id === id))
        .filter((c) => Boolean(c));
    let nextClocks;
    if (dirtyList.length > 0) {
        const base = await loadConvClocksMem();
        nextClocks = mergeConvClocks(base, dirtyList);
        convClocksMem = nextClocks;
    }
    if (writePagesRoot) {
        writes.push(firestoreRootRevisionWrite(store.updatedAt, {
            pages: store.pages,
            convClocks: nextClocks,
        }));
    }
    else if (convIds.length > 0) {
        writes.push(firestoreRootRevisionWrite(store.updatedAt, {
            convClocks: nextClocks,
        }));
    }
    for (const id of convIds) {
        const conv = store.conversations.find((c) => c.id === id);
        if (conv) {
            writes.push(firestoreConversationCommitWrite(id, serializeConversationForPersist(conv)));
        }
    }
    await firestoreCommit(writes);
    if (dirty !== undefined && dirtyList.length > 0 && dirtyList.length <= 32) {
        patchStoreReadMemCacheAfterPartialWrite(store.pages, store.updatedAt, dirtyList);
    }
    else {
        invalidateStoreReadCache();
    }
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
    if (res.status === 404) {
        return tryReadFirestoreSubcollectionsOnly();
    }
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `Firestore read failed (${res.status})`);
    const doc = JSON.parse(raw);
    const fields = doc.fields;
    if (!fields)
        return null;
    if (fields.pagesJson?.stringValue) {
        return readV2StoreFromRootFields(fields);
    }
    const legacyJson = fields.json?.stringValue;
    const sv = fields.schemaVersion?.integerValue;
    if (legacyJson && sv !== String(FACEBOOK_STORE_SCHEMA_V2)) {
        let store;
        try {
            store = JSON.parse(legacyJson);
        }
        catch {
            return null;
        }
        console.warn('[facebook-store] Đang migrate Firestore legacy (1 document) → v2 (subcollection / hội thoại).');
        await migrateLegacyFirestoreToV2(store);
        return store;
    }
    return null;
}
async function writeStoreToFirestore(store, opts) {
    await writeStoreToFirestoreV2(store, opts);
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
async function readStoreUncached() {
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
                        await writeStore(store);
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
    storeReadMemCache = { store, at: Date.now() };
    return store;
}
async function readStore(opts) {
    const ttl = resolveStoreReadCacheMs();
    if (!opts?.bypassCache && ttl > 0 && storeReadMemCache) {
        const age = Date.now() - storeReadMemCache.at;
        if (age < ttl)
            return storeReadMemCache.store;
    }
    if (opts?.bypassCache)
        return readStoreUncached();
    if (storeReadInFlightPromise)
        return storeReadInFlightPromise;
    storeReadInFlightPromise = readStoreUncached().finally(() => {
        storeReadInFlightPromise = null;
    });
    return storeReadInFlightPromise;
}
async function writeStore(store, opts) {
    if (FACEBOOK_STORE_BACKEND === 'file') {
        invalidateStoreReadCache();
        await writeStoreToFile(store);
        storeReadMemCache = { store, at: Date.now() };
        return;
    }
    await writeStoreToFirestore(store, opts);
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
    if (/\/audioclip[-/]/i.test(url))
        return true;
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
                const audioish = kind === 'audio' || kind === 'voice' || isLikelyAudioUrl(url);
                const videoish = !audioish &&
                    (kind === 'video' ||
                        kind === 'video_inline' ||
                        (kind === 'file' && isLikelyVideoUrl(url)) ||
                        isLikelyVideoUrl(url));
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
        if (isLikelyAudioUrl(legacyUrl))
            audios.push(legacyUrl);
        else if (kind === 'video' || kind === 'video_inline' || (kind === 'file' && isLikelyVideoUrl(legacyUrl)))
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
/** Bỏ `raw` (payload webhook QC) khỏi JSON inbox — làm nhẹ egress; chi tiết đầy đủ chỉ trong Firestore. */
function stripAdAttributionForWire(att) {
    if (!att)
        return undefined;
    if (att.raw === undefined)
        return att;
    const { raw: _, ...rest } = att;
    return Object.keys(rest).length ? rest : undefined;
}
function stripMessageForWire(msg) {
    if (!msg.referral?.raw)
        return msg;
    return { ...msg, referral: stripAdAttributionForWire(msg.referral) };
}
/** Preview danh sách hội thoại — bỏ URL media (fbcdn rất dài) để giảm egress. */
function stripMessageForInboxPreview(msg) {
    const base = stripMessageForWire(msg);
    return {
        id: base.id,
        author: base.author,
        text: base.text,
        timestamp: base.timestamp,
        ...(base.isEcho ? { isEcho: base.isEcho } : {}),
    };
}
/** Cắt tin + attribution khi trả GET /api/facebook/conversations. Full store vẫn trên Firestore. */
export function trimStoreForInboxApi(store, opts) {
    const focusId = opts?.focusConversationId?.trim();
    const maxFull = FACEBOOK_INBOX_API_MAX_MESSAGES;
    const maxPreview = FACEBOOK_INBOX_API_LIST_PREVIEW_MESSAGES;
    let conversations = store.conversations;
    if (FACEBOOK_INBOX_API_MAX_CONVERSATIONS > 0 && conversations.length > FACEBOOK_INBOX_API_MAX_CONVERSATIONS) {
        conversations = conversations.slice(0, FACEBOOK_INBOX_API_MAX_CONVERSATIONS);
    }
    return {
        ...store,
        conversations: conversations.map((c) => {
            const focused = Boolean(focusId && c.id === focusId);
            const cap = focused ? maxFull : maxPreview;
            const slice = cap <= 0
                ? []
                : c.messages.length <= cap
                    ? c.messages
                    : c.messages.slice(-cap);
            const messages = focused
                ? slice.map(stripMessageForWire)
                : slice.map(stripMessageForInboxPreview);
            return { ...c, ad: stripAdAttributionForWire(c.ad), messages };
        }),
    };
}
export async function listFacebookConversations(opts) {
    const since = opts?.since?.trim();
    const clientClocks = opts?.clientClocks;
    const hasClientClocks = clientClocks && Object.keys(clientClocks).length > 0;
    if (since) {
        const cached = storeReadMemCache?.store;
        if (cached?.updatedAt === since) {
            return { unchanged: true, updatedAt: since, pages: cached.pages };
        }
        if (useFirestoreFacebookStore()) {
            try {
                const meta = await readFirestoreRootInboxMeta();
                if (meta && meta.updatedAt === since) {
                    return { unchanged: true, updatedAt: since, pages: meta.pages };
                }
                if (meta && hasClientClocks && Object.keys(meta.convClocks).length > 0) {
                    const { changedIds, removedIds } = diffConvClocks(meta.convClocks, clientClocks);
                    if (changedIds.length === 0 && removedIds.length === 0) {
                        return { unchanged: true, updatedAt: meta.updatedAt, pages: meta.pages };
                    }
                    const loaded = [];
                    for (const id of changedIds) {
                        const c = await readConversationFromFirestore(id);
                        if (c)
                            loaded.push(c);
                    }
                    loaded.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
                    const trimmed = {
                        pages: meta.pages,
                        conversations: loaded,
                        updatedAt: meta.updatedAt,
                    };
                    const conversations = opts?.forInboxApi
                        ? trimStoreForInboxApi(trimmed, { focusConversationId: opts.focusConversationId })
                            .conversations
                        : loaded;
                    convClocksMem = meta.convClocks;
                    return {
                        partial: true,
                        updatedAt: meta.updatedAt,
                        pages: meta.pages,
                        conversations,
                        convClocks: meta.convClocks,
                        removedConversationIds: removedIds,
                    };
                }
            }
            catch (e) {
                console.warn('[facebook-store] inbox delta read failed:', e);
            }
        }
    }
    const store = await readStore();
    const sorted = {
        ...store,
        conversations: [...store.conversations].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
    };
    const out = opts?.forInboxApi
        ? trimStoreForInboxApi(sorted, { focusConversationId: opts.focusConversationId })
        : sorted;
    const convClocks = buildConvClocksFromConversations(store.conversations);
    convClocksMem = convClocks;
    return { ...out, convClocks, fullSync: true };
}
/** Đọc store thô (cho AI inbox — không sort). Dùng cache TTL ngắn — webhook write tự invalidate. */
export async function readFacebookStoreSnapshot() {
    return readStore();
}
/** Đọc tối thiểu cho AI: 1 hội thoại + fanpage (Firestore: 2 read thay vì list N doc). */
export async function readFacebookStoreForConversation(conversationId, pageId) {
    if (useFirestoreFacebookStore()) {
        const [{ pages }, conv] = await Promise.all([
            readFacebookPagesCached(),
            readConversationFromFirestore(conversationId),
        ]);
        if (!conv)
            return null;
        const page = pages.find((p) => p.id === pageId);
        if (!page)
            return null;
        return { conv, page };
    }
    const store = await readStore();
    const conv = store.conversations.find((c) => c.id === conversationId);
    const page = store.pages.find((p) => p.id === pageId);
    if (!conv || !page)
        return null;
    return { conv, page };
}
const BRANCH_IDS = new Set(BRANCH_PAGES.map((b) => b.id));
const AI_REPLY_CLAIM_TTL_MS = 3 * 60 * 1000;
const fileStoreClaimChains = new Map();
function firestoreConversationDocUrl(conversationId) {
    return `${firestoreConversationsCollectionUrl()}/${encodeURIComponent(conversationId)}`;
}
function lastCustomerMessageIndex(conv) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (normalizeStoredMessageAuthor(conv.messages[i].author, conv.messages[i].id) === 'customer') {
            return i;
        }
    }
    return -1;
}
/** Tin khách gần nhất trong thread (cùng logic sweep / claim — không dùng messages[length-1]). */
export function getLastCustomerMessage(conv) {
    const idx = lastCustomerMessageIndex(conv);
    if (idx < 0)
        return undefined;
    return conv.messages[idx];
}
function hasSalonOutboundAfterCustomer(conv) {
    const idx = lastCustomerMessageIndex(conv);
    if (idx < 0)
        return false;
    return conv.messages.slice(idx + 1).some((m) => isSalonOutboundAuthor(m.author));
}
function canClaimAiReplyForCustomer(conv, customerMessageId) {
    const custIdx = lastCustomerMessageIndex(conv);
    if (custIdx < 0)
        return { ok: false, reason: 'no_customer' };
    const cust = conv.messages[custIdx];
    if (cust.id !== customerMessageId)
        return { ok: false, reason: 'stale_customer' };
    if (conv.aiRepliedToCustomerMessageId === customerMessageId) {
        return { ok: false, reason: 'already_replied' };
    }
    if (hasSalonOutboundAfterCustomer(conv)) {
        return { ok: false, reason: 'outbound_exists' };
    }
    const claimId = conv.aiReplyClaimMessageId?.trim();
    const claimAt = conv.aiReplyClaimAt ? Date.parse(conv.aiReplyClaimAt) : NaN;
    const claimFresh = claimId && Number.isFinite(claimAt) && Date.now() - claimAt < AI_REPLY_CLAIM_TTL_MS;
    if (claimFresh && claimId === customerMessageId) {
        return { ok: false, reason: 'claim_held' };
    }
    if (claimFresh && claimId !== customerMessageId) {
        const claimIdx = conv.messages.findIndex((m) => m.id === claimId);
        // Claim còn hạn trên tin khách cũ — khách đã nhắn tiếp → cho claim tin mới.
        if (claimIdx >= 0 && claimIdx < custIdx) {
            return { ok: true };
        }
        return { ok: false, reason: 'other_claim' };
    }
    return { ok: true };
}
/** Hội thoại cần AI trả lời (sau debounce, chưa có tin salon sau tin khách cuối). */
export function conversationNeedsAiReply(conv, page, opts) {
    if (process.env.FACEBOOK_AI_AUTO_REPLY?.trim() === '0')
        return false;
    if (!page || page.aiMasterEnabled === false)
        return false;
    if (conv.aiEnabled === false)
        return false;
    const now = opts.now ?? Date.now();
    const custIdx = lastCustomerMessageIndex(conv);
    if (custIdx < 0)
        return false;
    const cust = conv.messages[custIdx];
    syncAiRepliedMarkerFromMessages(conv);
    if (conv.aiRepliedToCustomerMessageId === cust.id)
        return false;
    if (hasSalonOutboundAfterCustomer(conv))
        return false;
    const claimId = conv.aiReplyClaimMessageId?.trim();
    const claimAt = conv.aiReplyClaimAt ? Date.parse(conv.aiReplyClaimAt) : NaN;
    const claimFresh = Boolean(claimId) && Number.isFinite(claimAt) && now - claimAt < AI_REPLY_CLAIM_TTL_MS;
    if (claimFresh && claimId === cust.id)
        return false;
    const custTs = Date.parse(cust.timestamp);
    if (Number.isFinite(custTs) && now - custTs < opts.minQuietMs)
        return false;
    return true;
}
function applyAiReplyClaim(conv, customerMessageId) {
    conv.aiReplyClaimMessageId = customerMessageId;
    conv.aiReplyClaimAt = new Date().toISOString();
}
function syncAiRepliedMarkerFromMessages(conv) {
    const idx = lastCustomerMessageIndex(conv);
    if (idx < 0)
        return;
    const cust = conv.messages[idx];
    if (!hasSalonOutboundAfterCustomer(conv))
        return;
    conv.aiRepliedToCustomerMessageId = cust.id;
    if (conv.aiReplyClaimMessageId === cust.id) {
        delete conv.aiReplyClaimMessageId;
        delete conv.aiReplyClaimAt;
    }
}
async function persistConversationClaim(conv) {
    if (FACEBOOK_STORE_BACKEND === 'firestore' && FIRESTORE_PROJECT_ID) {
        const url = firestoreConversationDocUrl(conv.id);
        const res = await fetchFirestoreWithAuth(url);
        const raw = await res.text();
        if (res.status === 404) {
            const updatedAt = new Date().toISOString();
            if (useFirestoreFacebookStore()) {
                const { pages } = await readFacebookPagesCached();
                await writeStore({ pages, conversations: [conv], updatedAt }, { dirtyConversationIds: new Set([conv.id]) });
            }
            else {
                const store = await readStore();
                if (!store.conversations.some((c) => c.id === conv.id)) {
                    store.conversations.unshift(conv);
                }
                store.updatedAt = updatedAt;
                await writeStore(store, { dirtyConversationIds: new Set([conv.id]) });
            }
            return true;
        }
        if (!res.ok)
            throw new Error(raw || `Firestore get conversation failed (${res.status})`);
        const doc = JSON.parse(raw);
        const updateTime = doc.updateTime;
        if (!updateTime) {
            await writeStore({ pages: [], conversations: [conv], updatedAt: new Date().toISOString() }, { dirtyConversationIds: new Set([conv.id]) });
            return true;
        }
        const writes = [
            {
                update: {
                    name: `${firestoreDocName()}/${FIRESTORE_CONVERSATIONS_SUBCOLLECTION}/${conv.id}`,
                    fields: { json: { stringValue: serializeConversationForPersist(conv) } },
                },
                updateMask: { fieldPaths: ['json'] },
                currentDocument: { updateTime },
            },
        ];
        try {
            await firestoreCommit(writes);
            return true;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/FAILED_PRECONDITION|ABORTED|409|conflict/i.test(msg))
                return false;
            throw e;
        }
    }
    const store = await readStore();
    const i = store.conversations.findIndex((c) => c.id === conv.id);
    if (i < 0)
        store.conversations.unshift(conv);
    else
        store.conversations[i] = conv;
    store.updatedAt = new Date().toISOString();
    await writeStore(store, { dirtyConversationIds: new Set([conv.id]) });
    return true;
}
async function fileTryClaimFacebookAiReply(conversationId, customerMessageId) {
    const prev = fileStoreClaimChains.get(conversationId) ?? Promise.resolve(true);
    const work = prev.then(async () => {
        const store = await readStore();
        let conv = store.conversations.find((c) => c.id === conversationId);
        if (!conv)
            return false;
        syncAiRepliedMarkerFromMessages(conv);
        const gate = canClaimAiReplyForCustomer(conv, customerMessageId);
        if (!gate.ok)
            return false;
        applyAiReplyClaim(conv, customerMessageId);
        await persistConversationClaim(conv);
        return true;
    });
    fileStoreClaimChains.set(conversationId, work.then(() => true).catch(() => true));
    return work;
}
/** Chỉ một instance / lượt được xử lý tin khách này (sau debounce ~20s). */
export async function tryClaimFacebookAiReply(conversationId, customerMessageId) {
    if (FACEBOOK_STORE_BACKEND === 'firestore' && FIRESTORE_PROJECT_ID) {
        const url = firestoreConversationDocUrl(conversationId);
        const res = await fetchFirestoreWithAuth(url);
        const raw = await res.text();
        if (res.status === 404)
            return false;
        if (!res.ok)
            throw new Error(raw || `Firestore get conversation failed (${res.status})`);
        const doc = JSON.parse(raw);
        const json = doc.fields?.json?.stringValue;
        if (!json)
            return false;
        let conv;
        try {
            conv = JSON.parse(json);
            repairConversationMessageAuthors(conv);
        }
        catch {
            return false;
        }
        syncAiRepliedMarkerFromMessages(conv);
        const gate = canClaimAiReplyForCustomer(conv, customerMessageId);
        if (!gate.ok)
            return false;
        applyAiReplyClaim(conv, customerMessageId);
        return persistConversationClaim(conv);
    }
    return fileTryClaimFacebookAiReply(conversationId, customerMessageId);
}
export async function markFacebookAiReplyCompleted(conversationId, customerMessageId) {
    const apply = (conv) => {
        conv.aiRepliedToCustomerMessageId = customerMessageId;
        if (conv.aiReplyClaimMessageId === customerMessageId) {
            delete conv.aiReplyClaimMessageId;
            delete conv.aiReplyClaimAt;
        }
    };
    if (FACEBOOK_STORE_BACKEND === 'firestore' && FIRESTORE_PROJECT_ID) {
        const url = firestoreConversationDocUrl(conversationId);
        const res = await fetchFirestoreWithAuth(url);
        if (!res.ok)
            return;
        const raw = await res.text();
        const doc = JSON.parse(raw);
        const json = doc.fields?.json?.stringValue;
        if (!json || !doc.updateTime)
            return;
        let conv;
        try {
            conv = JSON.parse(json);
        }
        catch {
            return;
        }
        apply(conv);
        await firestoreCommit([
            {
                update: {
                    name: `${firestoreDocName()}/${FIRESTORE_CONVERSATIONS_SUBCOLLECTION}/${conversationId}`,
                    fields: { json: { stringValue: serializeConversationForPersist(conv) } },
                },
                updateMask: { fieldPaths: ['json'] },
                currentDocument: { updateTime: doc.updateTime },
            },
        ]).catch(() => undefined);
        return;
    }
    const store = await readStore();
    const conv = store.conversations.find((c) => c.id === conversationId);
    if (!conv)
        return;
    apply(conv);
    store.updatedAt = new Date().toISOString();
    await writeStore(store, { dirtyConversationIds: new Set([conversationId]) });
}
export async function releaseFacebookAiReplyClaim(conversationId, customerMessageId) {
    const apply = (conv) => {
        if (conv.aiReplyClaimMessageId !== customerMessageId)
            return;
        delete conv.aiReplyClaimMessageId;
        delete conv.aiReplyClaimAt;
    };
    if (FACEBOOK_STORE_BACKEND === 'firestore' && FIRESTORE_PROJECT_ID) {
        const url = firestoreConversationDocUrl(conversationId);
        const res = await fetchFirestoreWithAuth(url);
        if (!res.ok)
            return;
        const raw = await res.text();
        const doc = JSON.parse(raw);
        const json = doc.fields?.json?.stringValue;
        if (!json || !doc.updateTime)
            return;
        let conv;
        try {
            conv = JSON.parse(json);
        }
        catch {
            return;
        }
        apply(conv);
        await firestoreCommit([
            {
                update: {
                    name: `${firestoreDocName()}/${FIRESTORE_CONVERSATIONS_SUBCOLLECTION}/${conversationId}`,
                    fields: { json: { stringValue: serializeConversationForPersist(conv) } },
                },
                updateMask: { fieldPaths: ['json'] },
                currentDocument: { updateTime: doc.updateTime },
            },
        ]).catch(() => undefined);
        return;
    }
    const store = await readStore();
    const conv = store.conversations.find((c) => c.id === conversationId);
    if (!conv)
        return;
    apply(conv);
    store.updatedAt = new Date().toISOString();
    await writeStore(store, { dirtyConversationIds: new Set([conversationId]) });
}
export async function patchFacebookConversation(conversationId, patch) {
    let conv;
    let pages = [];
    if (useFirestoreFacebookStore()) {
        const loaded = await readConversationFromFirestore(conversationId);
        if (!loaded)
            return false;
        conv = loaded;
        pages = (await readFacebookPagesCached()).pages;
    }
    else {
        const store = await readStore();
        conv = store.conversations.find((c) => c.id === conversationId);
        pages = store.pages;
    }
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
    const updatedAt = new Date().toISOString();
    if (useFirestoreFacebookStore()) {
        await writeStore({ pages, conversations: [conv], updatedAt }, { dirtyConversationIds: new Set([conversationId]) });
    }
    else {
        const store = await readStore();
        const i = store.conversations.findIndex((c) => c.id === conversationId);
        if (i >= 0)
            store.conversations[i] = conv;
        store.updatedAt = updatedAt;
        await writeStore(store, { dirtyConversationIds: new Set([conversationId]) });
    }
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
    await writeStore(store, { dirtyConversationIds: new Set(), writePagesRoot: true });
    return page;
}
/** Cộng dồn chi phí ước tính và ghi nhận cache hit cho lần gọi Gemini gần nhất. */
export async function applyFacebookConversationAiUsage(input) {
    const updatedAt = new Date().toISOString();
    if (useFirestoreFacebookStore()) {
        const conv = await readConversationFromFirestore(input.conversationId);
        if (!conv)
            return;
        const prev = conv.aiEstimatedTotalUsd ?? 0;
        conv.aiEstimatedTotalUsd = prev + Math.max(0, input.addUsd);
        conv.aiLastContextCacheHit = input.contextCacheHit;
        conv.aiLastRunAt = updatedAt;
        const { pages } = await readFacebookPagesCached();
        await writeStore({ pages, conversations: [conv], updatedAt }, { dirtyConversationIds: new Set([input.conversationId]) });
        return;
    }
    const store = await readStore();
    const conv = store.conversations.find((c) => c.id === input.conversationId);
    if (!conv)
        return;
    const prev = conv.aiEstimatedTotalUsd ?? 0;
    conv.aiEstimatedTotalUsd = prev + Math.max(0, input.addUsd);
    conv.aiLastContextCacheHit = input.contextCacheHit;
    conv.aiLastRunAt = updatedAt;
    store.updatedAt = updatedAt;
    await writeStore(store, { dirtyConversationIds: new Set([input.conversationId]) });
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
    await writeStore(store, { dirtyConversationIds: new Set(), writePagesRoot: true });
    return store.pages;
}
export async function enrichFacebookConversationProfiles(resolveCustomerProfile, options) {
    const store = await readStore();
    const maxPerRun = options?.maxPerRun ?? Number.POSITIVE_INFINITY;
    const concurrency = Math.max(1, Math.min(options?.concurrency ?? 4, 8));
    const totalConversations = store.conversations.length;
    const allPending = store.conversations.filter((c) => !c.customerName || !c.avatarUrl);
    const pending = allPending.slice(0, maxPerRun);
    if (!pending.length) {
        return { updatedFields: 0, remainingPending: allPending.length, totalConversations };
    }
    let updated = 0;
    const touchedIds = new Set();
    for (let i = 0; i < pending.length; i += concurrency) {
        const chunk = pending.slice(i, i + concurrency);
        await Promise.all(chunk.map(async (conversation) => {
            const profile = await resolveCustomerProfile(conversation.pageId, conversation.customerPsid).catch(() => null);
            if (!profile?.name && !profile?.avatarUrl)
                return;
            if (profile.name && profile.name !== conversation.customerName) {
                conversation.customerName = profile.name;
                updated += 1;
                touchedIds.add(conversation.id);
            }
            if (profile.avatarUrl && profile.avatarUrl !== conversation.avatarUrl) {
                conversation.avatarUrl = profile.avatarUrl;
                updated += 1;
                touchedIds.add(conversation.id);
            }
        }));
    }
    if (updated) {
        store.updatedAt = new Date().toISOString();
        await writeStore(store, { dirtyConversationIds: touchedIds });
    }
    const remainingPending = store.conversations.filter((c) => !c.customerName || !c.avatarUrl).length;
    return { updatedFields: updated, remainingPending, totalConversations };
}
export async function ingestFacebookWebhookPayload(payload, options) {
    const body = payload;
    const entries = Array.isArray(body.entry) ? body.entry : [];
    const firestoreIngest = useFirestoreFacebookStore();
    const convAccum = new Map();
    let pages;
    let fileStore = null;
    let pagesRootWrite = false;
    if (firestoreIngest) {
        const cachedPages = await readFacebookPagesCached();
        pages = [...cachedPages.pages];
    }
    else {
        fileStore = await readStore({ bypassCache: true });
        pages = fileStore.pages;
    }
    const touchConversation = async (pageId, customerPsid, timestamp, profile) => {
        if (fileStore) {
            return upsertConversation(fileStore, pageId, customerPsid, timestamp, profile);
        }
        const id = `${pageId}:${customerPsid}`;
        let conversation = convAccum.get(id);
        if (!conversation) {
            conversation =
                (await readConversationFromFirestore(id)) ??
                    {
                        id,
                        pageId,
                        customerPsid,
                        title: `Khách ${customerPsid.slice(-6)}`,
                        updatedAt: timestamp,
                        lastMessageAt: timestamp,
                        messages: [],
                    };
            convAccum.set(id, conversation);
        }
        if (profile?.name)
            conversation.customerName = profile.name;
        if (profile?.avatarUrl)
            conversation.avatarUrl = profile.avatarUrl;
        conversation.updatedAt = timestamp;
        conversation.lastMessageAt = timestamp;
        return conversation;
    };
    let conversationsTouched = 0;
    let messagesStored = 0;
    const pendingAiReplies = [];
    const catalogDeferred = [];
    const dirtyConvIds = new Set();
    let storeMutated = false;
    for (const entry of entries) {
        const pageId = entry.id;
        if (!pageId || !Array.isArray(entry.messaging))
            continue;
        if (!pages.some((page) => page.id === pageId)) {
            pages.push({ id: pageId, name: `Fanpage ${pageId}`, connected: true });
            storeMutated = true;
            if (firestoreIngest)
                pagesRootWrite = true;
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
                const conversation = await touchConversation(pageId, customerPsid, timestamp, profile);
                if (event.read?.watermark)
                    conversation.customerReadAt = isoFromMetaTimestamp(event.read.watermark);
                if (event.delivery?.watermark)
                    conversation.pageDeliveredAt = isoFromMetaTimestamp(event.delivery.watermark);
                conversationsTouched += 1;
                dirtyConvIds.add(conversation.id);
                storeMutated = true;
                continue;
            }
            const message = event.message;
            const postback = event.postback;
            if (!message && !postback && !event.referral)
                continue;
            const isEcho = Boolean(message?.is_echo);
            const customerPsid = senderId === pageId ? recipientId : senderId;
            const profile = await options?.resolveCustomerProfile?.(pageId, customerPsid).catch(() => null);
            const conversation = await touchConversation(pageId, customerPsid, timestamp, profile);
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
            const qrPayload = typeof message?.quick_reply?.payload === 'string' ? message.quick_reply.payload.trim() : '';
            const pbPayload = typeof postback?.payload === 'string' ? postback.payload.trim() : '';
            const catalogParsed = parseCatalogPayload(qrPayload) || parseCatalogPayload(pbPayload) || parseCatalogPayload(message?.text);
            const catalogInvitePhrase = author === 'customer' &&
                !isEcho &&
                !catalogParsed &&
                messengerCatalogInviteFromCustomerText(message?.text?.trim() ?? '');
            let text = message?.text?.trim() ||
                postback?.title?.trim() ||
                postback?.payload?.trim() ||
                '';
            if (catalogParsed)
                text = catalogTapDisplayLine(catalogParsed);
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
            const skipCatalogAi = author === 'customer' && !isEcho && (Boolean(catalogParsed) || catalogInvitePhrase);
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
                const getMessengerCatalogToken = options?.messengerCatalogGetToken;
                if (getMessengerCatalogToken && skipCatalogAi) {
                    const page = pageId;
                    const psid = customerPsid;
                    if (catalogParsed?.kind === 'parent') {
                        const code = catalogParsed.code;
                        catalogDeferred.push(() => sendMessengerCatalogChildMenu(getMessengerCatalogToken, page, psid, code));
                    }
                    else if (catalogParsed?.kind === 'child') {
                        const key = catalogParsed.key;
                        catalogDeferred.push(() => sendMessengerCatalogSampleImages(getMessengerCatalogToken, page, psid, key));
                    }
                    else if (catalogInvitePhrase) {
                        catalogDeferred.push(() => sendMessengerCatalogParentMenu(getMessengerCatalogToken, page, psid));
                    }
                }
                if (author === 'customer' && !isEcho && !skipCatalogAi) {
                    pendingAiReplies.push({
                        conversationId: conversation.id,
                        pageId,
                        customerPsid,
                    });
                }
            }
            else if (author === 'customer' && !isEcho && !skipCatalogAi) {
                syncAiRepliedMarkerFromMessages(conversation);
                const pageRec = pages.find((p) => p.id === pageId);
                if (conversationNeedsAiReply(conversation, pageRec, { minQuietMs: 0 })) {
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
                syncAiRepliedMarkerFromMessages(conversation);
            }
            conversationsTouched += 1;
            dirtyConvIds.add(conversation.id);
            storeMutated = true;
        }
    }
    if (storeMutated) {
        const updatedAt = new Date().toISOString();
        if (fileStore) {
            fileStore.pages = pages;
            fileStore.updatedAt = updatedAt;
            await writeStore(fileStore, { dirtyConversationIds: dirtyConvIds });
        }
        else {
            const dirtyConversations = [...dirtyConvIds]
                .map((id) => convAccum.get(id))
                .filter((c) => Boolean(c));
            await writeStore({ pages, conversations: dirtyConversations, updatedAt }, {
                dirtyConversationIds: dirtyConvIds,
                writePagesRoot: pagesRootWrite,
            });
        }
    }
    const dedupedPending = [...new Map(pendingAiReplies.map((p) => [p.conversationId, p])).values()];
    return {
        conversationsTouched,
        messagesStored,
        pendingAiReplies: dedupedPending,
        catalogDeferred,
    };
}
/** Ghi tin page gửi đi sau Graph thành công; echo webhook trùng `id` sẽ không thêm bản sao. */
export async function appendOutboundFacebookMessage(input) {
    const convId = `${input.pageId}:${input.customerPsid}`;
    let pages = [];
    let conv;
    if (useFirestoreFacebookStore()) {
        const cached = await readFacebookPagesCached();
        pages = cached.pages;
        conv = (await readConversationFromFirestore(convId)) ?? undefined;
    }
    else {
        const store = await readStore();
        pages = store.pages;
        conv = store.conversations.find((c) => c.id === convId);
    }
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
    if (normalizedAuthor === 'ai') {
        const custIdx = lastCustomerMessageIndex(conv);
        if (custIdx >= 0) {
            const custId = conv.messages[custIdx].id;
            conv.aiRepliedToCustomerMessageId = custId;
            if (conv.aiReplyClaimMessageId === custId) {
                delete conv.aiReplyClaimMessageId;
                delete conv.aiReplyClaimAt;
            }
        }
    }
    conv.lastMessageAt = input.message.timestamp;
    conv.updatedAt = input.message.timestamp;
    const updatedAt = new Date().toISOString();
    if (useFirestoreFacebookStore()) {
        await writeStore({ pages, conversations: [conv], updatedAt }, { dirtyConversationIds: new Set([convId]) });
    }
    else {
        const store = await readStore();
        const i = store.conversations.findIndex((c) => c.id === convId);
        if (i < 0)
            store.conversations.unshift(conv);
        else
            store.conversations[i] = conv;
        store.updatedAt = updatedAt;
        await writeStore(store, { dirtyConversationIds: new Set([convId]) });
    }
}
