import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { writeMaybeCompressed } from "./compression.js";
import { verifyContextEditToken } from "./context-auth.js";
import { readJsonBody, readRawBody } from "./request-body.js";
import { resolveFacebookAiReplyDebounceMs, scheduleFacebookAiReplies, } from "./facebook-ai-reply.js";
import { bootstrapFacebookTokensFromVault, facebookTokenAutoRefreshEnabled, fetchAllPageTokensFromUserToken, pageTokenMapFromRows, refreshFacebookPageTokensFromEnvUserToken, } from "./facebook-token-refresh.js";
import { loadFacebookTokenVault } from "./facebook-token-vault.js";
import { appendOutboundFacebookMessage, enrichFacebookConversationProfiles, ingestFacebookWebhookPayload, listFacebookConversations, patchFacebookConversation, patchFacebookPage, readFacebookStoreSnapshot, saveFacebookPages, } from "./facebook-store.js";
const pageTokenCache = new Map();
const customerProfileCache = new Map();
let profileEnrichInFlight = false;
/** Tránh gọi enrich Graph mỗi lần poll inbox (4s) — gây lag server + UI. */
let lastInboxPollProfileEnrichAt = 0;
const INBOX_POLL_PROFILE_ENRICH_MIN_MS = 120_000;
let pageTokenRefreshTimer = null;
function facebookAiReplyDeps() {
    return {
        getPageToken: getPageTokenForPage,
        graphSendText: graphSendMessengerJson,
        graphSendImageFromUrl: graphSendMessengerImageFromUrl,
    };
}
function scheduleBackgroundProfileEnrichment() {
    if (profileEnrichInFlight)
        return;
    profileEnrichInFlight = true;
    void (async () => {
        let totalUpdated = 0;
        let lastRemaining = 0;
        try {
            for (let round = 0; round < 15; round++) {
                const result = await enrichFacebookConversationProfiles(fetchCustomerProfile, {
                    maxPerRun: 50,
                    concurrency: 8,
                });
                totalUpdated += result.updatedFields;
                lastRemaining = result.remainingPending;
                if (result.updatedFields === 0)
                    break;
                await new Promise((r) => setTimeout(r, 150));
            }
            if (totalUpdated > 0) {
                console.log(`[facebook] background enriched ${totalUpdated} customer profile field(s)`);
            }
        }
        catch (e) {
            console.warn('[facebook] background profile enrich failed:', e);
        }
        finally {
            profileEnrichInFlight = false;
            if (lastRemaining > 0) {
                setTimeout(() => scheduleBackgroundProfileEnrichment(), 3000);
            }
        }
    })();
}
function writeJsonRaw(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}
function writeJsonCompressed(req, res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    writeMaybeCompressed(req, res, JSON.stringify(body));
}
function makeJsonResponder(req) {
    return (res, status, body) => writeJsonCompressed(req, res, status, body);
}
/** Chỉ cho phép tải ảnh/video từ host Meta (tránh proxy mở). */
function parseAllowedFacebookMediaUrl(raw) {
    try {
        const u = new URL(raw);
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
/** Lấy ảnh/video/permalink bài QC qua Graph (URL webhook thường hết hạn). */
export async function resolveAdCreativeMedia(pageId, postId) {
    const token = await getPageTokenForPage(pageId);
    if (!token)
        return {};
    const url = new URL(`https://graph.facebook.com/v20.0/${postId}`);
    url.searchParams.set('fields', 'full_picture,permalink_url,attachments{media_type,media{image{src},video{source}}}');
    url.searchParams.set('access_token', token);
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) {
        return { permalinkUrl: `https://www.facebook.com/${pageId}/posts/${postId}` };
    }
    const body = (await res.json().catch(() => ({})));
    let imageUrl = body.full_picture?.trim();
    let videoUrl;
    for (const att of body.attachments?.data ?? []) {
        const mt = (att.media_type || '').toLowerCase();
        const img = att.media?.image?.src?.trim();
        const vid = att.media?.video?.source?.trim();
        if (mt === 'video' && vid)
            videoUrl = vid;
        if (img && !imageUrl)
            imageUrl = img;
    }
    const permalinkUrl = body.permalink_url?.trim() || `https://www.facebook.com/${pageId}/posts/${postId}`;
    return {
        imageUrl: imageUrl || undefined,
        videoUrl: videoUrl || undefined,
        permalinkUrl,
    };
}
async function consumeWebStreamWithByteCap(body, maxBytes) {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (!value?.byteLength)
                continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => { });
                return 'over';
            }
            chunks.push(Buffer.from(value));
        }
        return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
    }
    catch {
        await reader.cancel().catch(() => { });
        return Buffer.alloc(0);
    }
}
/** Proxy ảnh inbox — tránh vídeo/reel và buffer không giới hạn (OOM Cloud Run → 502). */
async function handleFacebookCdnMediaProxy(res, target) {
    const parsed = parseAllowedFacebookMediaUrl(target);
    if (!parsed || target.length > 8000) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('URL không hợp lệ hoặc không được phép.');
        return;
    }
    const maxBytesRaw = Number(process.env.FACEBOOK_CDN_PROXY_MAX_BYTES?.trim());
    const maxBodyBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? Math.floor(maxBytesRaw) : 12 * 1024 * 1024;
    const fetchMsRaw = Number(process.env.FACEBOOK_CDN_PROXY_FETCH_MS?.trim());
    const fetchTimeoutMs = Number.isFinite(fetchMsRaw) && fetchMsRaw > 0 ? Math.floor(fetchMsRaw) : 25_000;
    const host = parsed.hostname.toLowerCase();
    const headers = {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };
    if (host.endsWith('fbsbx.com') ||
        host.endsWith('facebook.com') ||
        host.endsWith('fb.com') ||
        host.endsWith('fbcdn.net')) {
        headers.Referer = 'https://www.facebook.com/';
    }
    let upstream = null;
    try {
        upstream = await fetch(parsed.toString(), {
            method: 'GET',
            redirect: 'follow',
            headers,
            signal: AbortSignal.timeout(fetchTimeoutMs),
        });
    }
    catch (err) {
        console.warn('[facebook cdn-media] fetch failed:', err instanceof Error ? err.message : err);
        upstream = null;
    }
    if (!upstream?.ok) {
        const status = upstream?.status || 502;
        res.statusCode = status === 403 ? 403 : 502;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(`Không tải được nội dung từ Facebook CDN (Status: ${status}).`);
        return;
    }
    const ctHeader = upstream.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
    const ctLower = ctHeader.toLowerCase();
    if (ctLower.startsWith('video/')) {
        await upstream.body?.cancel().catch(() => { });
        res.statusCode = 415;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Chỉ proxy ảnh cho inbox; URL trả về video (reel) — vui lòng không dùng đường này.');
        return;
    }
    const cl = upstream.headers.get('content-length');
    if (cl) {
        const n = Number(cl);
        if (Number.isFinite(n) && n > maxBodyBytes) {
            await upstream.body?.cancel().catch(() => { });
            res.statusCode = 413;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Nội dung quá lớn cho proxy ảnh.');
            return;
        }
    }
    if (!upstream.body) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Phản hồi CDN không có body.');
        return;
    }
    const buf = await consumeWebStreamWithByteCap(upstream.body, maxBodyBytes);
    if (buf === 'over') {
        res.statusCode = 413;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Nội dung vượt giới hạn proxy ảnh.');
        return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', ctHeader);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(buf);
}
function envFlag(name) {
    return Boolean(process.env[name]?.trim());
}
function startFacebookPageTokenRefreshLoop() {
    if (!facebookTokenAutoRefreshEnabled())
        return;
    const hours = Number(process.env.FACEBOOK_TOKEN_REFRESH_INTERVAL_HOURS) || 6;
    const ms = Math.max(1, hours) * 60 * 60 * 1000;
    if (pageTokenRefreshTimer)
        clearInterval(pageTokenRefreshTimer);
    pageTokenRefreshTimer = setInterval(() => {
        void warmFacebookPageTokenCache().catch((e) => console.warn('[facebook] periodic token refresh failed:', e));
    }, ms);
    console.log(`[facebook] Tự làm mới page token mỗi ${hours}h (từ FACEBOOK_USER_ACCESS_TOKEN)`);
}
/** Khởi động: page token + webhook → debounce → AI (không quét Firestore định kỳ). */
export function startFacebookMessagingBootstrap() {
    void (async () => {
        try {
            await warmFacebookPageTokenCache();
        }
        catch (e) {
            console.warn('[facebook] warmFacebookPageTokenCache failed:', e);
        }
        startFacebookPageTokenRefreshLoop();
        const debounceMs = resolveFacebookAiReplyDebounceMs();
        console.log(`[facebook-ai] Webhook → debounce ${debounceMs}ms → trả lời (retry khi lỗi tạm).`);
    })().catch((e) => console.warn('[facebook] bootstrap failed:', e));
}
/** Ghi data/facebook-webhook-last.json mỗi webhook.
 *  Mặc định: TẮT trên Cloud Run (K_SERVICE) hoặc khi FACEBOOK_WEBHOOK_NO_DEBUG_FILE=1.
 *  Bật lại trên dev bằng FACEBOOK_WEBHOOK_DEBUG_FILE=1. */
function shouldWriteWebhookDebugFile() {
    if (envFlag('FACEBOOK_WEBHOOK_NO_DEBUG_FILE'))
        return false;
    if (envFlag('FACEBOOK_WEBHOOK_DEBUG_FILE'))
        return true;
    if (process.env.K_SERVICE)
        return false;
    return true;
}
const WEBHOOK_DEBUG_DIR = process.env.CONTEXT_DATA_DIR?.trim() || resolve(process.cwd(), 'data');
async function dumpFacebookWebhookDebug(body) {
    await mkdir(WEBHOOK_DEBUG_DIR, { recursive: true });
    const filePath = resolve(WEBHOOK_DEBUG_DIR, 'facebook-webhook-last.json');
    await writeFile(filePath, `${JSON.stringify({ receivedAt: new Date().toISOString(), body }, null, 2)}\n`, 'utf8');
}
function verifyFacebookSignature(req, rawBody) {
    const appSecret = process.env.FACEBOOK_APP_SECRET?.trim();
    if (!appSecret)
        return true;
    const signature = req.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !signature.startsWith('sha256='))
        return false;
    const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const receivedHex = signature.slice('sha256='.length);
    const expected = Buffer.from(expectedHex, 'hex');
    const received = Buffer.from(receivedHex, 'hex');
    return received.length === expected.length && timingSafeEqual(received, expected);
}
export function readFacebookPageTokens() {
    const single = process.env.FACEBOOK_PAGE_ACCESS_TOKEN?.trim();
    const many = process.env.FACEBOOK_PAGE_ACCESS_TOKENS?.trim();
    return Array.from(new Set([
        ...(single ? [single] : []),
        ...(many ? many.split(/[,\s]+/) : []),
    ].filter(Boolean)));
}
async function probePageAccessToken(pageId, token) {
    const url = new URL(`https://graph.facebook.com/v20.0/${encodeURIComponent(pageId)}`);
    url.searchParams.set('fields', 'id');
    url.searchParams.set('access_token', token);
    const res = await fetch(url).catch(() => null);
    if (!res?.ok)
        return false;
    const body = (await res.json().catch(() => ({})));
    return body.id === pageId;
}
async function fetchFacebookPagesFromTokens() {
    const pages = [];
    const tokens = readFacebookPageTokens();
    for (const token of tokens) {
        const url = new URL('https://graph.facebook.com/v20.0/me');
        url.searchParams.set('fields', 'id,name,picture.type(large)');
        url.searchParams.set('access_token', token);
        const res = await fetch(url).catch(() => null);
        if (!res?.ok) {
            const errText = (await res?.text().catch(() => '')) ?? '';
            console.warn(`[facebook] Page token /me failed (${res?.status ?? 'network'}): ${errText.slice(0, 200)}`);
            continue;
        }
        const page = (await res.json());
        if (page.id) {
            pageTokenCache.set(page.id, token);
            pages.push(page);
        }
    }
    return Array.from(new Map(pages.map((page) => [page.id, page])).values());
}
/** Gọi lúc khởi động — map page id ↔ token, log fanpage thiếu token. */
export async function warmFacebookPageTokenCache() {
    pageTokenCache.clear();
    await bootstrapFacebookTokensFromVault();
    const vaultBoot = await loadFacebookTokenVault();
    if (vaultBoot?.pageTokens) {
        for (const [id, token] of Object.entries(vaultBoot.pageTokens)) {
            const t = token?.trim();
            if (id && t)
                pageTokenCache.set(id, t);
        }
    }
    if (facebookTokenAutoRefreshEnabled()) {
        const refreshed = await refreshFacebookPageTokensFromEnvUserToken();
        console.log(`[facebook] ${refreshed.message}`);
        if (refreshed.ok) {
            const userToken = process.env.FACEBOOK_USER_ACCESS_TOKEN?.trim();
            if (userToken) {
                const rows = await fetchAllPageTokensFromUserToken(userToken);
                for (const [id, token] of pageTokenMapFromRows(rows)) {
                    pageTokenCache.set(id, token);
                }
            }
        }
    }
    const pages = await fetchFacebookPagesFromTokens();
    const ids = pages.map((p) => p.id).filter(Boolean);
    console.log(`[facebook] Page token cache: ${ids.length} fanpage (${ids.join(', ') || 'trống — kiểm tra FACEBOOK_PAGE_ACCESS_TOKEN(S)'})`);
}
async function getPageTokenForPage(pageId) {
    const cached = pageTokenCache.get(pageId);
    if (cached)
        return cached;
    await fetchFacebookPagesFromTokens();
    const afterMe = pageTokenCache.get(pageId);
    if (afterMe)
        return afterMe;
    for (const token of readFacebookPageTokens()) {
        if (pageTokenCache.has(pageId))
            break;
        const ok = await probePageAccessToken(pageId, token);
        if (ok) {
            pageTokenCache.set(pageId, token);
            console.log(`[facebook] Mapped page ${pageId} → token (probe)`);
            return token;
        }
    }
    console.warn(`[facebook] Không có page token cho ${pageId}. Các page đã map: ${[...pageTokenCache.keys()].join(', ') || '(trống)'}`);
    return null;
}
function partitionAttachmentUrls(rows) {
    const images = [];
    const videos = [];
    const audios = [];
    for (const row of rows ?? []) {
        const url = typeof row.file_url === 'string' ? row.file_url.trim() : '';
        if (!url.startsWith('http'))
            continue;
        const mt = (row.mime_type || '').toLowerCase();
        if (mt.startsWith('video/'))
            videos.push(url);
        else if (mt.startsWith('audio/'))
            audios.push(url);
        else
            images.push(url);
    }
    return { images, videos, audios };
}
/**
 * Webhook đôi khi chỉ gửi sticker_id / thiếu URL; Graph trả `file_url` theo message id.
 * Thử cả edge /attachments và object gốc ?fields=attachments{…} (shape khác nhau tùng API).
 * @see https://developers.facebook.com/docs/graph-api/reference/message/attachments/
 */
async function fetchMessageAttachmentsFromGraph(pageId, messageMid) {
    const token = await getPageTokenForPage(pageId);
    if (!token || !messageMid.trim())
        return { images: [], videos: [], audios: [] };
    const midEnc = encodeURIComponent(messageMid);
    const base = `https://graph.facebook.com/v20.0/${midEnc}`;
    const fetchRows = async (pathAndQuery) => {
        const graphUrl = new URL(`${base}${pathAndQuery}`);
        graphUrl.searchParams.set('access_token', token);
        const res = await fetch(graphUrl).catch(() => null);
        if (!res)
            return { ok: false, status: 0 };
        if (!res.ok) {
            const errBody = envFlag('FACEBOOK_WEBHOOK_DEBUG_GRAPH')
                ? await res.text().catch(() => '')
                : '';
            console.warn(`[facebook] Graph ${pathAndQuery.split('?')[0] || pathAndQuery} → ${res.status} ${errBody.slice(0, 400)}`);
            return { ok: false, status: res.status };
        }
        const parsed = (await res.json());
        if (Array.isArray(parsed.data)) {
            return { ok: true, status: res.status, rows: parsed.data };
        }
        const nested = parsed.attachments?.data;
        if (Array.isArray(nested))
            return { ok: true, status: res.status, rows: nested };
        return { ok: true, status: res.status, rows: [] };
    };
    let rows;
    const edge = await fetchRows(`/attachments?fields=${encodeURIComponent('file_url,mime_type')}`);
    if (edge.rows?.length)
        rows = edge.rows;
    if (!rows?.length) {
        const root = await fetchRows(`?fields=${encodeURIComponent('attachments{file_url,mime_type}')}`);
        if (root.rows?.length)
            rows = root.rows;
    }
    const { images, videos, audios } = partitionAttachmentUrls(rows);
    return {
        images: [...new Set(images)],
        videos: [...new Set(videos)],
        audios: [...new Set(audios)],
    };
}
async function fetchCustomerProfile(pageId, customerPsid) {
    const cacheKey = `${pageId}:${customerPsid}`;
    const cached = customerProfileCache.get(cacheKey);
    if (cached)
        return cached;
    const token = await getPageTokenForPage(pageId);
    if (!token)
        return null;
    const url = new URL(`https://graph.facebook.com/v20.0/${customerPsid}`);
    url.searchParams.set('fields', 'first_name,last_name,name,profile_pic,picture.type(large)');
    url.searchParams.set('access_token', token);
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) {
        if (envFlag('FACEBOOK_WEBHOOK_DEBUG_GRAPH')) {
            const errText = (await res?.text().catch(() => '')) ?? '';
            console.warn(`[facebook] profile ${customerPsid} page ${pageId} → ${res?.status} ${errText.slice(0, 300)}`);
        }
        return null;
    }
    const profile = (await res.json());
    const name = profile.name?.trim() ||
        [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() ||
        undefined;
    const avatarUrl = profile.profile_pic?.trim() || profile.picture?.data?.url?.trim() || undefined;
    const normalized = { name, avatarUrl };
    if (name || avatarUrl)
        customerProfileCache.set(cacheKey, normalized);
    return normalized;
}
/** Chẩn đoán vì sao không có tên/avatar khách (dùng token CONTEXT_EDITOR_TOKEN). */
export async function diagnoseCustomerProfile(pageId, customerPsid) {
    const conversationId = `${pageId}:${customerPsid}`;
    const store = await readFacebookStoreSnapshot();
    const conv = store.conversations.find((c) => c.id === conversationId);
    const storeSlice = {
        customerName: conv?.customerName,
        avatarUrl: conv?.avatarUrl,
        hasName: Boolean(conv?.customerName?.trim()),
        hasAvatar: Boolean(conv?.avatarUrl?.trim()),
    };
    const token = await getPageTokenForPage(pageId);
    if (!token) {
        return {
            conversationId,
            pageId,
            customerPsid,
            store: storeSlice,
            pageToken: { found: false },
            graph: { httpStatus: null },
            resolvedProfile: null,
            cause: 'NO_PAGE_TOKEN',
            hint: 'Không có page access token cho fanpage này. Thêm token page vào FACEBOOK_PAGE_ACCESS_TOKENS (đúng page id) rồi deploy.',
        };
    }
    const url = new URL(`https://graph.facebook.com/v20.0/${customerPsid}`);
    url.searchParams.set('fields', 'first_name,last_name,name,profile_pic,picture.type(large)');
    url.searchParams.set('access_token', token);
    const res = await fetch(url).catch(() => null);
    if (!res) {
        return {
            conversationId,
            pageId,
            customerPsid,
            store: storeSlice,
            pageToken: { found: true },
            graph: { httpStatus: null },
            resolvedProfile: null,
            cause: 'GRAPH_NETWORK',
            hint: 'Server không gọi được graph.facebook.com (mạng/DNS/firewall).',
        };
    }
    const raw = (await res.json().catch(() => ({})));
    if (!res.ok) {
        const err = raw.error;
        const code = err?.code;
        let cause = 'GRAPH_ERROR';
        let hint = err?.message || `Graph HTTP ${res.status}`;
        if (code === 190) {
            cause = 'TOKEN_INVALID';
            hint = 'Page access token hết hạn hoặc bị thu hồi. Lấy token mới từ Meta và cập nhật env.';
        }
        else if (code === 10 || code === 200 || res.status === 403) {
            cause = 'PERMISSION_OR_POLICY';
            hint =
                'App thiếu quyền hoặc Meta chặn User Profile (pages_messaging + Advanced Access). Khách phải đã nhắn page trong 24h (hoặc theo policy hiện tại).';
        }
        else if (code === 100 || code === 803) {
            cause = 'INVALID_PSID';
            hint = 'PSID không hợp lệ hoặc không thuộc fanpage này.';
        }
        return {
            conversationId,
            pageId,
            customerPsid,
            store: storeSlice,
            pageToken: { found: true },
            graph: { httpStatus: res.status, error: err },
            resolvedProfile: null,
            cause,
            hint,
        };
    }
    const name = raw.name?.trim() ||
        [raw.first_name, raw.last_name].filter(Boolean).join(' ').trim() ||
        undefined;
    const avatarUrl = raw.profile_pic?.trim() || raw.picture?.data?.url?.trim() || undefined;
    const resolvedProfile = { name, avatarUrl };
    if (!name && !avatarUrl) {
        return {
            conversationId,
            pageId,
            customerPsid,
            store: storeSlice,
            pageToken: { found: true },
            graph: { httpStatus: res.status, name, avatarUrl },
            resolvedProfile: null,
            cause: 'GRAPH_EMPTY_PROFILE',
            hint: 'Graph trả 200 nhưng không có name/profile_pic — thường do khách chưa đủ điều kiện hiển thị profile hoặc app chưa được Meta duyệt quyền profile.',
        };
    }
    if (storeSlice.hasName && storeSlice.hasAvatar) {
        return {
            conversationId,
            pageId,
            customerPsid,
            store: storeSlice,
            pageToken: { found: true },
            graph: { httpStatus: res.status, name, avatarUrl },
            resolvedProfile,
            cause: 'STORE_OK_CHECK_UI',
            hint: 'Firestore đã có tên + avatar. Nếu UI vẫn “Khách xxx”: hard refresh, kiểm tra proxy ảnh /api/facebook/cdn-media?u=...',
        };
    }
    return {
        conversationId,
        pageId,
        customerPsid,
        store: storeSlice,
        pageToken: { found: true },
        graph: { httpStatus: res.status, name, avatarUrl },
        resolvedProfile,
        cause: 'GRAPH_OK_STORE_NOT_SAVED',
        hint: 'Graph có dữ liệu nhưng store chưa lưu — đợi enrich nền (poll inbox) hoặc gọi lại GET /api/facebook/conversations. Nếu vẫn trống: kiểm tra quyền ghi Firestore.',
    };
}
export async function getFacebookStatus() {
    const appId = envFlag('FACEBOOK_APP_ID');
    const appSecret = envFlag('FACEBOOK_APP_SECRET');
    const pageTokenCount = readFacebookPageTokens().length;
    const pageAccessToken = pageTokenCount > 0;
    const verifyToken = envFlag('FACEBOOK_VERIFY_TOKEN');
    const vault = await loadFacebookTokenVault().catch(() => null);
    const publicUrl = process.env.FACEBOOK_WEBHOOK_PUBLIC_URL?.trim() || process.env.APP_PUBLIC_URL?.trim();
    return {
        configured: appId && appSecret && pageAccessToken && verifyToken,
        appId,
        appSecret,
        pageAccessToken,
        pageTokenCount,
        tokenAutoRefresh: facebookTokenAutoRefreshEnabled(),
        tokenVaultUpdatedAt: vault?.updatedAt,
        tokenVaultLastMessage: vault?.lastRefreshMessage,
        verifyToken,
        webhookUrl: publicUrl ? `${publicUrl.replace(/\/$/, '')}/api/facebook/webhook` : '/api/facebook/webhook',
        webhookLogRawBody: envFlag('FACEBOOK_WEBHOOK_LOG_RAW_BODY'),
        webhookDebugFile: shouldWriteWebhookDebugFile(),
        graphAttachmentsFallback: !envFlag('FACEBOOK_DISABLE_GRAPH_ATTACHMENTS'),
    };
}
function parseDataUrlImage(dataUrl) {
    const compact = dataUrl.replace(/\s/g, '');
    const m = /^data:(image\/[\w+.-]+);base64,(.+)$/i.exec(compact);
    if (!m)
        return null;
    try {
        const buffer = Buffer.from(m[2], 'base64');
        if (!buffer.length || buffer.length > 8 * 1024 * 1024)
            return null;
        return { buffer, mime: m[1].toLowerCase() };
    }
    catch {
        return null;
    }
}
async function graphSendMessengerJson(token, recipientPsid, text) {
    const url = new URL('https://graph.facebook.com/v20.0/me/messages');
    url.searchParams.set('access_token', token);
    const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            recipient: { id: recipientPsid },
            messaging_type: 'RESPONSE',
            message: { text },
        }),
    }).catch(() => null);
    if (!res)
        return { error: { message: 'Lỗi mạng khi gọi Graph.' } };
    return (await res.json());
}
async function graphSendMessengerImage(token, recipientPsid, buffer, mime) {
    const form = new FormData();
    form.append('recipient', JSON.stringify({ id: recipientPsid }));
    form.append('message', JSON.stringify({
        attachment: { type: 'image', payload: { is_reusable: false } },
    }));
    const ext = mime.includes('png') ? 'upload.png' : mime.includes('webp') ? 'upload.webp' : 'upload.jpg';
    form.append('filedata', new Blob([buffer], { type: mime }), ext);
    const url = new URL('https://graph.facebook.com/v20.0/me/messages');
    url.searchParams.set('access_token', token);
    const res = await fetch(url.toString(), { method: 'POST', body: form }).catch(() => null);
    if (!res)
        return { error: { message: 'Lỗi mạng khi gửi ảnh (multipart).' } };
    return (await res.json());
}
const MESSENGER_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
function mimeFromImagePath(p) {
    const e = extname(p).toLowerCase();
    if (e === '.png')
        return 'image/png';
    if (e === '.webp')
        return 'image/webp';
    if (e === '.gif')
        return 'image/gif';
    return 'image/jpeg';
}
function absoluteFileUnderPublicOrDist(rawPath) {
    const rel = rawPath.trim().replace(/^\/+/, '').replace(/\\/g, '/');
    if (!rel || rel.includes('..'))
        return null;
    const cwd = resolve(process.cwd());
    for (const rootName of ['public', 'dist']) {
        const root = resolve(cwd, rootName);
        const abs = resolve(root, rel);
        if (abs !== root && !abs.startsWith(root + sep))
            continue;
        if (existsSync(abs))
            return abs;
    }
    return null;
}
async function loadImageBytesForMessengerSend(rawUrl) {
    const t = rawUrl.trim();
    if (!t)
        return { ok: false, message: 'URL ảnh rỗng.' };
    if (!/^https?:\/\//i.test(t)) {
        const abs = absoluteFileUnderPublicOrDist(t);
        if (abs) {
            try {
                const buffer = await readFile(abs);
                if (!buffer.length || buffer.length > MESSENGER_IMAGE_MAX_BYTES) {
                    return { ok: false, message: 'Ảnh quá lớn hoặc rỗng.' };
                }
                return { ok: true, buffer, mime: mimeFromImagePath(abs) };
            }
            catch {
                /* fall through to HTTP */
            }
        }
    }
    let fetchUrl = t;
    if (!/^https?:\/\//i.test(t)) {
        const port = Number(process.env.CONTEXT_CACHE_SERVER_PORT) || 8787;
        const pub = process.env.APP_PUBLIC_URL?.trim();
        let origin;
        if (pub && /^https?:\/\//i.test(pub)) {
            try {
                origin = new URL(pub).origin;
            }
            catch {
                origin = `http://127.0.0.1:${port}`;
            }
        }
        else {
            origin = `http://127.0.0.1:${port}`;
        }
        fetchUrl = new URL(t.startsWith('/') ? t : `/${t}`, `${origin}/`).toString();
    }
    const res = await fetch(fetchUrl, { redirect: 'follow' }).catch(() => null);
    if (!res?.ok) {
        return { ok: false, message: `Không tải được ảnh (${fetchUrl.length > 140 ? `${fetchUrl.slice(0, 140)}…` : fetchUrl}).` };
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > MESSENGER_IMAGE_MAX_BYTES) {
        return { ok: false, message: 'Ảnh quá lớn hoặc rỗng.' };
    }
    const ct = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
    const pathGuess = fetchUrl.split(/[?#]/)[0] ?? fetchUrl;
    const mime = ct.startsWith('image/') ? ct : mimeFromImagePath(pathGuess);
    if (!mime.startsWith('image/'))
        return { ok: false, message: 'URL không phải ảnh.' };
    return { ok: true, buffer, mime };
}
/** Ảnh mẫu catalog (đường dẫn tương đối hoặc URL tuyệt đối) → tải bytes → multipart Graph. */
async function graphSendMessengerImageFromUrl(token, recipientPsid, imageUrlOrPath) {
    const loaded = await loadImageBytesForMessengerSend(imageUrlOrPath);
    if (!loaded.ok)
        return { error: { message: loaded.message } };
    return graphSendMessengerImage(token, recipientPsid, loaded.buffer, loaded.mime);
}
async function handleFacebookSendMessage(req, res) {
    const json = makeJsonResponder(req);
    const cfg = await getFacebookStatus();
    if (!cfg.configured) {
        json(res, 400, { ok: false, error: 'Thiếu cấu hình Facebook (App ID, Secret, Page token, Verify token).' });
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    }
    catch {
        json(res, 400, { ok: false, error: 'JSON không hợp lệ hoặc quá lớn.' });
        return;
    }
    const parsed = body;
    const pageId = typeof parsed.pageId === 'string' ? parsed.pageId.trim() : '';
    const recipientPsid = typeof parsed.recipientPsid === 'string' ? parsed.recipientPsid.trim() : '';
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    const imageDataUrl = typeof parsed.imageDataUrl === 'string' ? parsed.imageDataUrl.trim() : '';
    if (!pageId || !recipientPsid) {
        json(res, 400, { ok: false, error: 'Thiếu pageId hoặc recipientPsid.' });
        return;
    }
    if (!text && !imageDataUrl) {
        json(res, 400, { ok: false, error: 'Cần nội dung text hoặc ảnh (data URL).' });
        return;
    }
    const token = await getPageTokenForPage(pageId);
    if (!token) {
        json(res, 400, {
            ok: false,
            error: 'Không có page access token cho fanpage này. Đặt FACEBOOK_PAGE_ACCESS_TOKEN (hoặc danh sách token) và gọi POST /api/facebook/sync.',
        });
        return;
    }
    const append = async (messageId, msgText) => {
        await appendOutboundFacebookMessage({
            pageId,
            customerPsid: recipientPsid,
            message: {
                id: messageId,
                author: 'staff',
                text: msgText,
                timestamp: new Date().toISOString(),
                isEcho: true,
            },
        });
    };
    if (text) {
        const r = await graphSendMessengerJson(token, recipientPsid, text);
        if (r.error?.message || !r.message_id) {
            json(res, 502, {
                ok: false,
                error: r.error?.message || 'Graph API không trả message_id cho tin text.',
            });
            return;
        }
        await append(r.message_id, text);
    }
    if (imageDataUrl) {
        const img = parseDataUrlImage(imageDataUrl);
        if (!img) {
            json(res, 400, { ok: false, error: 'Ảnh phải là data URL dạng data:image/...;base64,...' });
            return;
        }
        const r = await graphSendMessengerImage(token, recipientPsid, img.buffer, img.mime);
        if (r.error?.message || !r.message_id) {
            json(res, 502, {
                ok: false,
                error: r.error?.message || 'Graph API không trả message_id cho ảnh.',
            });
            return;
        }
        await append(r.message_id, '');
    }
    json(res, 200, { ok: true });
}
export async function handleFacebookApi(req, res, url) {
    if (!url.pathname.startsWith('/api/facebook'))
        return false;
    const json = makeJsonResponder(req);
    if (req.method === 'GET' && url.pathname === '/api/facebook/status') {
        json(res, 200, await getFacebookStatus());
        return true;
    }
    if ((req.method === 'GET' || req.method === 'POST') &&
        (url.pathname === '/api/facebook/conversations' ||
            url.pathname === '/api/facebook/conversations/poll')) {
        const now = Date.now();
        if (now - lastInboxPollProfileEnrichAt >= INBOX_POLL_PROFILE_ENRICH_MIN_MS) {
            lastInboxPollProfileEnrichAt = now;
            scheduleBackgroundProfileEnrichment();
        }
        let since;
        let focusConversationId;
        let clientClocks;
        if (req.method === 'POST') {
            const body = (await readJsonBody(req));
            since = body.since?.trim() || undefined;
            focusConversationId = body.focus?.trim() || undefined;
            if (body.clocks && typeof body.clocks === 'object' && !Array.isArray(body.clocks)) {
                clientClocks = body.clocks;
            }
        }
        else {
            since = url.searchParams.get('since')?.trim() || undefined;
            focusConversationId = url.searchParams.get('focus')?.trim() || undefined;
        }
        json(res, 200, await listFacebookConversations({
            forInboxApi: true,
            since,
            focusConversationId,
            clientClocks,
        }));
        return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/facebook/cdn-media') {
        const target = url.searchParams.get('u')?.trim() ?? '';
        try {
            await handleFacebookCdnMediaProxy(res, target);
        }
        catch {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Lỗi proxy media.');
        }
        return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/facebook/ad-creative') {
        const pageId = url.searchParams.get('pageId')?.trim() ?? '';
        const postId = url.searchParams.get('postId')?.trim() ?? '';
        if (!pageId || !postId) {
            json(res, 400, { ok: false, error: 'Cần query pageId và postId.' });
            return true;
        }
        try {
            const media = await resolveAdCreativeMedia(pageId, postId);
            json(res, 200, { ok: true, ...media });
        }
        catch (e) {
            json(res, 500, {
                ok: false,
                error: e instanceof Error ? e.message : String(e),
            });
        }
        return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/facebook/debug-customer-profile') {
        if (!verifyContextEditToken(req)) {
            json(res, 401, { ok: false, error: 'Thiếu hoặc sai X-Context-Edit-Token / Authorization Bearer.' });
            return true;
        }
        const pageId = url.searchParams.get('pageId')?.trim() ?? '';
        const psid = url.searchParams.get('psid')?.trim() ?? url.searchParams.get('customerPsid')?.trim() ?? '';
        if (!pageId || !psid) {
            json(res, 400, {
                ok: false,
                error: 'Cần query pageId và psid (hoặc customerPsid). conversationId = pageId:psid.',
            });
            return true;
        }
        try {
            const diagnosis = await diagnoseCustomerProfile(pageId, psid);
            json(res, 200, { ok: true, ...diagnosis });
        }
        catch (e) {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/sync') {
        const status = await getFacebookStatus();
        if (!status.configured) {
            json(res, 200, {
                ok: false,
                configured: false,
                error: 'Thiếu Facebook app/page token. Endpoint đã sẵn sàng nhưng chưa thể gọi Graph API thật.',
            });
            return true;
        }
        const graphPages = await fetchFacebookPagesFromTokens();
        const pages = await saveFacebookPages(graphPages
            .filter((page) => page.id && page.name)
            .map((page) => ({
            id: page.id,
            name: page.name,
            avatarUrl: page.picture?.data?.url,
            connected: true,
        })));
        scheduleBackgroundProfileEnrichment();
        json(res, 200, {
            ok: true,
            configured: true,
            pages,
            syncedAt: new Date().toISOString(),
        });
        return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/send') {
        try {
            await handleFacebookSendMessage(req, res);
        }
        catch (e) {
            json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/facebook/webhook') {
        const mode = url.searchParams.get('hub.mode');
        const token = url.searchParams.get('hub.verify_token');
        const challenge = url.searchParams.get('hub.challenge');
        if (mode === 'subscribe' && token && token === process.env.FACEBOOK_VERIFY_TOKEN) {
            res.statusCode = 200;
            res.end(challenge ?? '');
            return true;
        }
        json(res, 403, { error: 'Facebook webhook verify token không hợp lệ.' });
        return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/webhook') {
        const rawBody = await readRawBody(req).catch(() => Buffer.from('{}'));
        if (!verifyFacebookSignature(req, rawBody)) {
            json(res, 403, { error: 'Facebook webhook signature không hợp lệ.' });
            return true;
        }
        const body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
        if (shouldWriteWebhookDebugFile()) {
            await dumpFacebookWebhookDebug(body).catch((err) => {
                console.warn('[facebook webhook] could not write data/facebook-webhook-last.json:', err);
            });
        }
        if (envFlag('FACEBOOK_WEBHOOK_LOG_RAW_BODY')) {
            try {
                console.log('[facebook webhook] raw body:\n', JSON.stringify(body, null, 2));
            }
            catch {
                console.log('[facebook webhook] raw body: <unserializable>');
            }
        }
        const stored = await ingestFacebookWebhookPayload(body, {
            resolveCustomerProfile: fetchCustomerProfile,
            fetchAttachmentMediaFromGraph: envFlag('FACEBOOK_DISABLE_GRAPH_ATTACHMENTS')
                ? undefined
                : fetchMessageAttachmentsFromGraph,
            messengerCatalogGetToken: getPageTokenForPage,
        });
        json(res, 200, {
            ok: true,
            receivedAt: new Date().toISOString(),
            stored,
        });
        if (stored.catalogDeferred.length) {
            void (async () => {
                for (const run of stored.catalogDeferred) {
                    await run().catch((e) => console.warn('[messenger-catalog]', e));
                }
            })();
        }
        if (stored.pendingAiReplies.length) {
            scheduleFacebookAiReplies(stored.pendingAiReplies, facebookAiReplyDeps());
        }
        if (stored.conversationsTouched > 0) {
            scheduleBackgroundProfileEnrichment();
        }
        return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/enrich-profiles') {
        if (!verifyContextEditToken(req)) {
            json(res, 401, { ok: false, error: 'Thiếu hoặc sai X-Context-Edit-Token / Authorization Bearer.' });
            return true;
        }
        scheduleBackgroundProfileEnrichment();
        const store = await readFacebookStoreSnapshot();
        const pending = store.conversations.filter((c) => !c.customerName || !c.avatarUrl).length;
        json(res, 200, {
            ok: true,
            message: 'Đang enrich profile khách nền (lặp đến khi hết hoặc Graph không trả thêm).',
            pendingProfiles: pending,
            totalConversations: store.conversations.length,
        });
        return true;
    }
    if (req.method === 'PATCH' && url.pathname === '/api/facebook/conversation') {
        let body;
        try {
            body = await readJsonBody(req);
        }
        catch {
            json(res, 400, { ok: false, error: 'JSON không hợp lệ hoặc quá lớn.' });
            return true;
        }
        const parsed = body;
        const conversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId.trim() : '';
        if (!conversationId) {
            json(res, 400, { ok: false, error: 'Thiếu conversationId.' });
            return true;
        }
        const hasAi = typeof parsed.aiEnabled === 'boolean';
        const hasBranch = 'branchPageId' in parsed;
        if (!hasAi && !hasBranch) {
            json(res, 400, { ok: false, error: 'Cần aiEnabled (boolean) hoặc branchPageId (số hoặc null).' });
            return true;
        }
        const patch = {};
        if (hasAi)
            patch.aiEnabled = parsed.aiEnabled;
        if (hasBranch) {
            if (parsed.branchPageId === null) {
                patch.branchPageId = null;
            }
            else if (typeof parsed.branchPageId === 'number' && Number.isFinite(parsed.branchPageId)) {
                patch.branchPageId = parsed.branchPageId;
            }
            else {
                json(res, 400, { ok: false, error: 'branchPageId phải là số chi nhánh hợp lệ hoặc null.' });
                return true;
            }
        }
        const ok = await patchFacebookConversation(conversationId, patch);
        if (!ok) {
            json(res, 404, { ok: false, error: 'Không tìm thấy hội thoại.' });
            return true;
        }
        json(res, 200, { ok: true });
        return true;
    }
    if (req.method === 'PATCH' && url.pathname === '/api/facebook/page') {
        let body;
        try {
            body = await readJsonBody(req);
        }
        catch {
            json(res, 400, { ok: false, error: 'JSON không hợp lệ hoặc quá lớn.' });
            return true;
        }
        const parsed = body;
        const pageId = typeof parsed.pageId === 'string' ? parsed.pageId.trim() : '';
        if (!pageId) {
            json(res, 400, { ok: false, error: 'Thiếu pageId.' });
            return true;
        }
        const hasMaster = typeof parsed.aiMasterEnabled === 'boolean';
        const hasBranch = 'defaultBranchPageId' in parsed;
        if (!hasMaster && !hasBranch) {
            json(res, 400, {
                ok: false,
                error: 'Cần aiMasterEnabled (boolean) hoặc defaultBranchPageId (số hoặc null).',
            });
            return true;
        }
        const patch = {};
        if (hasMaster)
            patch.aiMasterEnabled = parsed.aiMasterEnabled;
        if (hasBranch) {
            if (parsed.defaultBranchPageId === null) {
                patch.defaultBranchPageId = null;
            }
            else if (typeof parsed.defaultBranchPageId === 'number' && Number.isFinite(parsed.defaultBranchPageId)) {
                patch.defaultBranchPageId = parsed.defaultBranchPageId;
            }
            else {
                json(res, 400, { ok: false, error: 'defaultBranchPageId phải là số chi nhánh hợp lệ hoặc null.' });
                return true;
            }
        }
        const page = await patchFacebookPage(pageId, patch);
        if (!page) {
            json(res, 404, { ok: false, error: 'Không tìm thấy fanpage hoặc chi nhánh không hợp lệ.' });
            return true;
        }
        json(res, 200, { ok: true, page });
        return true;
    }
    return false;
}
