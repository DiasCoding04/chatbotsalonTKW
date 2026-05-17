/**
 * Menu ảnh mẫu Messenger 2 lớp: nút cha (nhóm lớn) → nút con (catalog key trong IMAGE_SAMPLES.md).
 */
import { DEFAULT_MAX_IMAGE_SAMPLES_PER_REPLY, IMAGE_SAMPLE_LEGACY_KEYS, resolveImageSampleUrl, normalizeSearchText, parseImageSampleGroups, } from "../shared/salon-ai-context.js";
import { readImageSamplesDocument } from "./context-store.js";
export const MESSENGER_CATALOG_PAYLOAD_PREFIX = 'TKW_IMG:';
/** Quick reply title tối đa (Meta Messenger). */
const QR_TITLE_MAX = 20;
/** 6 nút cha → mỗi nhánh ≤ 8 nút con (< giới hạn ~11 của Meta). */
export const IMAGE_CATALOG_PARENTS = [
    {
        code: 'JOIN',
        title: 'Nối · lông vũ',
        keys: ['moi_noi_long_vu', 'noi_toc', 'noi_long_vu_den'],
    },
    {
        code: 'CUT',
        title: 'Cắt · mái · tém',
        keys: ['toc_ngan_bob_tem', 'mai_thua', 'mai_bay', 'mai_phap', 'mai_ngang'],
    },
    {
        code: 'DUOI',
        title: 'Duỗi',
        keys: ['duoi_ngan', 'duoi_dai'],
    },
    {
        code: 'CURL',
        title: 'Uốn',
        keys: [
            'uon_cup',
            'uon_song_ngan',
            'uon_song_dai',
            'uon_hippie',
            'uon_xoan_tang',
            'uon_xoan_luoi_dai',
            'uon_xoan_luoi_ngan',
        ],
    },
    {
        code: 'BAC',
        title: 'Phủ bạc · bạc',
        keys: ['nhuom_phu_bac', 'phu_bac_mau_tram', 'toc_bac'],
    },
    {
        code: 'CLR',
        title: 'Nhuộm màu',
        keys: ['mau_tram', 'mau_thoi_trang', 'mau_balayage', 'mau_babylight', 'nhuom_sang_khong_tay'],
    },
];
/** Nhãn nút con (≤20 ký tự); key phải trùng filename prefix trong IMAGE_SAMPLES. */
export const IMAGE_CATALOG_CHILD_TITLES = {
    moi_noi_long_vu: 'Mối nối long vũ',
    noi_toc: 'Nối tóc',
    noi_long_vu_den: 'Nối lông vũ đen',
    toc_ngan_bob_tem: 'Tém · bob ngắn',
    mai_thua: 'Mái thưa',
    mai_bay: 'Mái bay',
    mai_phap: 'Mái pháp',
    mai_ngang: 'Mái ngang',
    duoi_ngan: 'Duỗi ngắn',
    duoi_dai: 'Duỗi dài',
    uon_cup: 'Uốn cụp',
    uon_song_ngan: 'Uốn sóng ngắn',
    uon_song_dai: 'Uốn sóng dài',
    uon_hippie: 'Hippie · xù mì',
    uon_xoan_tang: 'Xoăn tầng',
    uon_xoan_luoi_dai: 'Xoăn lười dài',
    uon_xoan_luoi_ngan: 'Xoăn lười ngắn',
    nhuom_phu_bac: 'Nhuộm phủ bạc',
    phu_bac_mau_tram: 'Phủ bạc trầm',
    toc_bac: 'Kiểu tóc bạc',
    mau_tram: 'Màu trầm (trẻ)',
    mau_thoi_trang: 'Thời trang',
    mau_balayage: 'Balayage',
    mau_babylight: 'Babylight',
    nhuom_sang_khong_tay: 'Sáng không tẩy',
};
function qrTitle(label) {
    const t = label.trim();
    if (t.length <= QR_TITLE_MAX)
        return t;
    return `${t.slice(0, Math.max(0, QR_TITLE_MAX - 1))}…`;
}
export function messengerCatalogInviteFromCustomerText(raw) {
    const trimmed = raw.trim();
    const n = normalizeSearchText(raw);
    return (/\b#\s*anhmau\b|\b#\s*anh\s*mau\b|\b#\s*samp(le)?anh\b|\bmenu\s+danh\s*sach\b/.test(n) ||
        /\bdanh\s*sach\s*anh\b|\bmenu\s+anh\b|\bchon\s+nhom\s+anh\b/.test(n) ||
        /** Cụm đòi mẫu/ảnh (ASCII-normalized): «xem/gửi mẫu», không match «muốn xem giá». */
        /\bxem\s+mau\b/.test(n) ||
        /\b(gui\s+mau|xin\s+mau|tham\s+khao\s+mau)\b/.test(n) ||
        /\b(muon\s+xem\s+mau|muon\s+xem\s+hinh|muon\s+xem\s+anh)\b/.test(n) ||
        /\b(co\s+hinh\s+mau|gui\s+hinh\s+mau|khoe\s+hinh\s+mau)\b/.test(n) ||
        /** Giữ có dấu khi không lọt normalize (vd. chỉ có ký tự đặc biệt ít đổi). */
        /(tham khảo mẫu|xem mẫu|gửi mẫu|gửi hình(?: mẫu)?|muốn xem mẫu|muốn xem hình|muốn xem ảnh|\bcó hình mẫu\b|\bcó ảnh mẫu\b)/iu.test(trimmed));
}
export function parentPayload(code) {
    return `${MESSENGER_CATALOG_PAYLOAD_PREFIX}P:${code}`;
}
export function childPayload(sampleKey) {
    return `${MESSENGER_CATALOG_PAYLOAD_PREFIX}K:${sampleKey}`;
}
export function parseCatalogPayload(raw) {
    const p = raw?.trim() ?? '';
    if (!p.startsWith(MESSENGER_CATALOG_PAYLOAD_PREFIX))
        return null;
    const rest = p.slice(MESSENGER_CATALOG_PAYLOAD_PREFIX.length);
    if (rest.startsWith('P:')) {
        const code = rest.slice(2).trim().toUpperCase();
        return code ? { kind: 'parent', code } : null;
    }
    if (rest.startsWith('K:')) {
        const key = rest.slice(2).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        return key ? { kind: 'child', key } : null;
    }
    return null;
}
/** Human-readable line để hiện trong inbox sau khi bấm. */
export function catalogTapDisplayLine(parsed) {
    if (parsed.kind === 'parent') {
        const def = IMAGE_CATALOG_PARENTS.find((p) => p.code === parsed.code);
        return `[Chọn nhóm ảnh] ${def?.title ?? parsed.code}`;
    }
    const label = IMAGE_CATALOG_CHILD_TITLES[parsed.key] ?? parsed.key.replace(/_/g, ' ');
    return `[Ảnh mẫu] ${label}`;
}
let groupsCache = null;
const GROUPS_TTL_MS = 60_000;
export async function loadImageSampleGroupsCached() {
    const now = Date.now();
    if (groupsCache && now - groupsCache.at < GROUPS_TTL_MS)
        return groupsCache.groups;
    const doc = await readImageSamplesDocument();
    const groups = parseImageSampleGroups(doc.content);
    groupsCache = { at: now, groups };
    return groups;
}
function groupsWithLegacyAliases(groups) {
    const map = new Map(groups.map((g) => [g.key, g]));
    for (const [legacyKey, currentKey] of Object.entries(IMAGE_SAMPLE_LEGACY_KEYS)) {
        const g = map.get(currentKey);
        if (g)
            map.set(legacyKey, g);
    }
    return map;
}
async function graphPostMessenger(token, body) {
    const url = new URL('https://graph.facebook.com/v20.0/me/messages');
    url.searchParams.set('access_token', token);
    const res = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
    }).catch(() => null);
    if (!res)
        return { ok: false, err: 'network' };
    const data = (await res.json());
    if (!res.ok) {
        const msg = typeof data.error?.message === 'string'
            ? data.error?.message ?? ''
            : '';
        return { ok: false, err: `${res.status} ${msg.slice(0, 200)}` };
    }
    return { ok: true };
}
async function graphSendQuickReplies(token, recipientPsid, text, quick_replies) {
    if (!quick_replies.length)
        return { ok: false, err: 'empty quick_replies' };
    return graphPostMessenger(token, {
        recipient: { id: recipientPsid },
        messaging_type: 'RESPONSE',
        message: {
            text,
            quick_replies,
        },
    });
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
    if (!res?.ok)
        return false;
    return true;
}
async function fetchImageBuffer(urlStr) {
    const res = await fetch(urlStr, { redirect: 'follow' }).catch(() => null);
    if (!res?.ok)
        return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length)
        return null;
    const ct = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'image/jpeg';
    const mime = ct.startsWith('image/') ? ct : 'image/jpeg';
    return { buf, mime };
}
async function graphSendMessengerText(token, recipientPsid, text) {
    await graphPostMessenger(token, {
        recipient: { id: recipientPsid },
        messaging_type: 'RESPONSE',
        message: { text },
    });
}
const MAX_SAMPLES_PER_REPLY = DEFAULT_MAX_IMAGE_SAMPLES_PER_REPLY;
export async function sendMessengerCatalogParentMenu(getToken, pageId, recipientPsid) {
    const token = await getToken(pageId);
    if (!token) {
        console.warn('[catalog-menu] không có Page token.');
        return;
    }
    const quick_replies = IMAGE_CATALOG_PARENTS.map((p) => ({
        content_type: 'text',
        title: qrTitle(p.title),
        payload: parentPayload(p.code),
    }));
    const r = await graphSendQuickReplies(token, recipientPsid, 'Chị chọn nhóm ảnh mẫu (bấm 1 ô bên dưới để có thêm mẫu con) ạ.', quick_replies);
    if (!r.ok)
        console.warn('[catalog-menu] send parent QR failed:', r.err);
}
export async function sendMessengerCatalogChildMenu(getToken, pageId, recipientPsid, parentCode) {
    const token = await getToken(pageId);
    if (!token) {
        console.warn('[catalog-menu] không có Page token.');
        return;
    }
    const def = IMAGE_CATALOG_PARENTS.find((p) => p.code.toUpperCase() === parentCode.toUpperCase());
    if (!def) {
        console.warn('[catalog-menu] parent code không hợp lệ:', parentCode);
        await graphSendMessengerText(token, recipientPsid, 'Nhóm chưa hợp lệ ạ, chị gõ menu ảnh mẫu hoặc #anhmau để mở lại nhé ạ.');
        return;
    }
    const quick_replies = def.keys.map((key) => ({
        content_type: 'text',
        title: qrTitle(IMAGE_CATALOG_CHILD_TITLES[key] ?? key),
        payload: childPayload(key),
    }));
    const r = await graphSendQuickReplies(token, recipientPsid, `Chọn kiểu trong nhóm "${def.title}":`, quick_replies);
    if (!r.ok)
        console.warn('[catalog-menu] send child QR failed:', r.err);
}
export async function sendMessengerCatalogSampleImages(getToken, pageId, recipientPsid, sampleKey) {
    const token = await getToken(pageId);
    if (!token)
        return;
    const baseUrl = process.env.IMAGE_SAMPLES_BASE_URL?.trim() || '';
    if (!/^https?:\/\//i.test(baseUrl)) {
        console.warn('[catalog-menu] thiếu IMAGE_SAMPLES_BASE_URL — không gửi được ảnh.');
        await graphSendMessengerText(token, recipientPsid, 'Salon đang thiếu IMAGE_SAMPLES_BASE_URL nên không gửi ảnh tự động được ạ. Chị tham khảo mẫu trên tin nhắn trước hoặc báo stylist ạ.');
        return;
    }
    const groups = await loadImageSampleGroupsCached();
    const map = groupsWithLegacyAliases(groups);
    let group = map.get(sampleKey.toLowerCase()) ??
        [...map.values()].find((g) => g.key.replace(/_/g, '') === sampleKey.replace(/_/g, ''));
    /** Accept legacy filenames */
    const legacyCanon = IMAGE_SAMPLE_LEGACY_KEYS[sampleKey];
    if (legacyCanon)
        group = map.get(legacyCanon) ?? group;
    if (!group) {
        console.warn('[catalog-menu] không tìm thấy catalog key:', sampleKey);
        await graphSendMessengerText(token, recipientPsid, 'Mẫu này tạm chưa có trong kho ảnh salon ạ.');
        return;
    }
    const label = IMAGE_CATALOG_CHILD_TITLES[group.key] ?? group.label;
    await graphSendMessengerText(token, recipientPsid, `${label} — em gửi vài ảnh mẫu gần với catalogue ạ (tối đa ${MAX_SAMPLES_PER_REPLY} ảnh).`);
    let sent = 0;
    const urls = group.urls
        .slice(0, MAX_SAMPLES_PER_REPLY)
        .map((u) => resolveImageSampleUrl(u, baseUrl))
        .filter((u) => /^https:\/\//i.test(u.trim()));
    for (const absolute of urls) {
        const fetched = await fetchImageBuffer(absolute);
        if (!fetched || fetched.buf.length > 8 * 1024 * 1024)
            continue;
        const ok = await graphSendMessengerImage(token, recipientPsid, fetched.buf, fetched.mime);
        if (ok)
            sent += 1;
    }
    if (sent === 0)
        console.warn('[catalog-menu] không gửi được ảnh nào cho key=', group.key);
}
