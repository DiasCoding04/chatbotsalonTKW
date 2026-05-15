import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const EARLY_REFRESH_MS = 60_000;
let cachedToken = null;
export function clearVertexAccessTokenCache() {
    cachedToken = null;
}
function base64Url(input) {
    return Buffer.from(input)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}
function readServiceAccount() {
    const inline = process.env.VERTEX_SERVICE_ACCOUNT_JSON?.trim();
    if (inline)
        return JSON.parse(inline);
    const file = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (!file)
        return null;
    return JSON.parse(readFileSync(file, 'utf8'));
}
function createJwt(sa) {
    if (!sa.client_email || !sa.private_key) {
        throw new Error('Service account JSON thiếu client_email hoặc private_key.');
    }
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64Url(JSON.stringify({
        iss: sa.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
    }));
    const unsigned = `${header}.${claim}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64');
    return `${unsigned}.${signature.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}
async function getMetadataAccessToken() {
    const res = await fetch(METADATA_TOKEN_URL, {
        method: 'GET',
        headers: { 'Metadata-Flavor': 'Google' },
    });
    const raw = await res.text();
    if (!res.ok)
        throw new Error(raw || `${res.status} ${res.statusText}`);
    const data = JSON.parse(raw);
    if (!data.access_token)
        throw new Error('Metadata token response thiếu access_token.');
    return { token: data.access_token, expiresIn: data.expires_in };
}
export function useVertexGeminiBackend() {
    return process.env.GEMINI_BACKEND?.trim().toLowerCase() === 'vertex';
}
export async function getVertexAccessToken() {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt > now + EARLY_REFRESH_MS) {
        return cachedToken.accessToken;
    }
    const serviceAccount = readServiceAccount();
    let token;
    let expiresIn = 3600;
    if (serviceAccount) {
        const assertion = createJwt(serviceAccount);
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion,
            }),
        });
        const raw = await res.text();
        if (!res.ok)
            throw new Error(raw || `${res.status} ${res.statusText}`);
        const data = JSON.parse(raw);
        if (!data.access_token)
            throw new Error('OAuth token response thiếu access_token.');
        token = data.access_token;
        expiresIn = data.expires_in ?? expiresIn;
    }
    else {
        const metadataToken = await getMetadataAccessToken();
        token = metadataToken.token;
        expiresIn = metadataToken.expiresIn ?? expiresIn;
    }
    cachedToken = {
        accessToken: token,
        expiresAt: now + expiresIn * 1000,
    };
    return cachedToken.accessToken;
}
