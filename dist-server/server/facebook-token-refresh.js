/**
 * Làm mới page access token từ FACEBOOK_USER_ACCESS_TOKEN (long-lived).
 * Gọi lúc khởi động / định kỳ để tránh hết hạn hàng loạt.
 */
const GRAPH = 'https://graph.facebook.com/v20.0';
import { applyVaultToProcessEnv, loadFacebookTokenVault, saveFacebookTokenVault, vaultFromPageRows, } from "./facebook-token-vault.js";
function envFlag(name) {
    return process.env[name]?.trim() === '1';
}
/** Mặc định luôn đổi user token sang long-lived khi có APP_ID/SECRET (trừ khi tắt rõ). */
function shouldExchangeUserToken() {
    if (envFlag('FACEBOOK_SKIP_USER_TOKEN_EXCHANGE'))
        return false;
    if (envFlag('FACEBOOK_EXCHANGE_USER_TOKEN'))
        return true;
    return true;
}
export function facebookTokenAutoRefreshEnabled() {
    if (process.env.FACEBOOK_TOKEN_REFRESH_ON_STARTUP?.trim() === '0')
        return false;
    return Boolean(process.env.FACEBOOK_USER_ACCESS_TOKEN?.trim());
}
async function exchangeLongLivedUserToken(shortToken, appId, appSecret) {
    const url = new URL(`${GRAPH}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('client_secret', appSecret);
    url.searchParams.set('fb_exchange_token', shortToken);
    const res = await fetch(url);
    const body = (await res.json().catch(() => ({})));
    if (!res.ok || !body.access_token) {
        throw new Error(body.error?.message || `Exchange token HTTP ${res.status}`);
    }
    return body.access_token;
}
export async function fetchAllPageTokensFromUserToken(userToken) {
    const pages = [];
    let next = `/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(userToken)}`;
    while (next) {
        const url = next.startsWith('http') ? next : `${GRAPH}${next}`;
        const res = await fetch(url);
        const body = (await res.json().catch(() => ({})));
        if (!res.ok) {
            throw new Error(body.error?.message || `accounts HTTP ${res.status}`);
        }
        for (const row of body.data ?? []) {
            if (row.id && row.access_token) {
                pages.push({
                    id: row.id,
                    name: row.name?.trim() || row.id,
                    access_token: row.access_token,
                });
            }
        }
        next = body.paging?.next || '';
    }
    return pages;
}
/** Cập nhật process.env page tokens (Cloud Run đọc từ env lúc chạy). */
export function applyPageTokensToProcessEnv(pages) {
    const tokens = pages.map((p) => p.access_token).filter(Boolean);
    if (!tokens.length)
        return;
    process.env.FACEBOOK_PAGE_ACCESS_TOKENS = tokens.join(',');
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = tokens[0];
}
/** Gọi sau refresh để map thẳng pageId → token (tránh đọc lại env chậm). */
export function pageTokenMapFromRows(pages) {
    return new Map(pages.map((p) => [p.id, p.access_token]));
}
export async function refreshFacebookPageTokensFromEnvUserToken() {
    const rawUser = process.env.FACEBOOK_USER_ACCESS_TOKEN?.trim();
    const appId = process.env.FACEBOOK_APP_ID?.trim();
    const appSecret = process.env.FACEBOOK_APP_SECRET?.trim();
    if (!rawUser || !appId || !appSecret) {
        return {
            ok: false,
            pageCount: 0,
            message: 'Thiếu FACEBOOK_USER_ACCESS_TOKEN hoặc APP_ID/SECRET',
        };
    }
    try {
        let userToken = rawUser;
        if (shouldExchangeUserToken()) {
            userToken = await exchangeLongLivedUserToken(rawUser, appId, appSecret);
            process.env.FACEBOOK_USER_ACCESS_TOKEN = userToken;
        }
        const pages = await fetchAllPageTokensFromUserToken(userToken);
        if (!pages.length) {
            const fail = { ok: false, pageCount: 0, message: 'Không lấy được fanpage từ /me/accounts' };
            try {
                await saveFacebookTokenVault(vaultFromPageRows(userToken, [], { ok: false, message: fail.message }));
            }
            catch {
                /* ignore vault write error */
            }
            return fail;
        }
        applyPageTokensToProcessEnv(pages);
        const result = {
            ok: true,
            pageCount: pages.length,
            message: `Đã làm mới ${pages.length} page token`,
        };
        try {
            await saveFacebookTokenVault(vaultFromPageRows(userToken, pages, { ok: true, message: result.message }));
        }
        catch (e) {
            console.warn('[facebook] Không lưu token vault:', e instanceof Error ? e.message : String(e));
        }
        return result;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, pageCount: 0, message: msg };
    }
}
/** Nạp token đã lưu (Firestore/file) trước khi gọi Graph — redeploy không dùng token env cũ. */
export async function bootstrapFacebookTokensFromVault() {
    const vault = await loadFacebookTokenVault();
    if (!vault?.pageTokens || !Object.keys(vault.pageTokens).length)
        return 0;
    const n = applyVaultToProcessEnv(vault);
    if (n > 0) {
        console.log(`[facebook] Đã nạp ${n} page token từ vault (${vault.updatedAt}) — ${vault.lastRefreshMessage ?? ''}`);
    }
    return n;
}
