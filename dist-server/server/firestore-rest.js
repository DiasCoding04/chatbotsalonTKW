import { clearVertexAccessTokenCache, getVertexAccessToken } from "./vertex-auth.js";
export function resolveFirestoreProjectId() {
    return (process.env.CONTEXT_FIRESTORE_PROJECT_ID?.trim() ||
        process.env.FACEBOOK_STORE_FIRESTORE_PROJECT_ID?.trim() ||
        process.env.VERTEX_AI_PROJECT_ID?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        '');
}
export function resolveFirestoreDatabase() {
    return (process.env.CONTEXT_FIRESTORE_DATABASE?.trim() ||
        process.env.FACEBOOK_STORE_FIRESTORE_DATABASE?.trim() ||
        '(default)');
}
export function resolveFirestoreCollection() {
    return (process.env.CONTEXT_FIRESTORE_COLLECTION?.trim() ||
        process.env.FACEBOOK_STORE_FIRESTORE_COLLECTION?.trim() ||
        'salon_chat');
}
export function contextFirestoreDocId() {
    return process.env.CONTEXT_FIRESTORE_DOC_ID?.trim() || 'salon_context';
}
export function contextFirestoreDocName() {
    const project = resolveFirestoreProjectId();
    if (!project)
        throw new Error('Thiếu Firestore project id cho CONTEXT.');
    const database = resolveFirestoreDatabase();
    const collection = resolveFirestoreCollection();
    return `projects/${project}/databases/${database}/documents/${collection}/${contextFirestoreDocId()}`;
}
export function contextFirestoreDocUrl() {
    return `https://firestore.googleapis.com/v1/${contextFirestoreDocName()}`;
}
export function firestoreCommitUrl() {
    const project = resolveFirestoreProjectId();
    const database = resolveFirestoreDatabase();
    return `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents:commit`;
}
export async function fetchFirestoreWithAuth(url, init = {}) {
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
    return fetch(url, {
        ...init,
        headers: {
            ...init.headers,
            Authorization: `Bearer ${token}`,
        },
    });
}
