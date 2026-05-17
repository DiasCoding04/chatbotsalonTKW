import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clearSharedContextCacheInFirestore, readContextFromFirestore, seedFirestoreContextFromPublicIfEmpty, useFirestoreContextBackend, writeContextToFirestore, } from "./context-firestore.js";
const DATA_DIR = process.env.CONTEXT_DATA_DIR?.trim() || resolve(process.cwd(), 'data');
const CONTEXT_FILE = process.env.CONTEXT_DATA_PATH?.trim() || resolve(DATA_DIR, 'CONTEXT.md');
const IMAGE_SAMPLES_FILE = process.env.IMAGE_SAMPLES_DATA_PATH?.trim() || resolve(DATA_DIR, 'IMAGE_SAMPLES.md');
const SEED_FILE = resolve(process.cwd(), 'public', 'CONTEXT.md');
const IMAGE_SAMPLES_SEED_FILE = resolve(process.cwd(), 'public', 'IMAGE_SAMPLES.md');
export function getContextFilePath() {
    return useFirestoreContextBackend() ? 'firestore://salon_context' : CONTEXT_FILE;
}
async function seedFile(target, seed, fallback) {
    try {
        await access(target);
        return;
    }
    catch {
        // Seed from public files when the server copy does not exist yet.
    }
    try {
        const content = await readFile(seed, 'utf8');
        await writeFile(target, content, 'utf8');
        return;
    }
    catch {
        await writeFile(target, fallback, 'utf8');
    }
}
export async function ensureContextFile() {
    if (useFirestoreContextBackend()) {
        await seedFirestoreContextFromPublicIfEmpty();
        return;
    }
    await mkdir(DATA_DIR, { recursive: true });
    await seedFile(CONTEXT_FILE, SEED_FILE, '# Salon context\n\n');
}
export async function ensureImageSamplesFile() {
    await mkdir(DATA_DIR, { recursive: true });
    await seedFile(IMAGE_SAMPLES_FILE, IMAGE_SAMPLES_SEED_FILE, '# Image samples\n\n');
}
const STAT_REVALIDATE_MS = 5_000;
let contextDocCache = null;
let imageSamplesDocCache = null;
async function readDocumentCached(filePath, ensure, slot, setSlot) {
    await ensure();
    const cached = slot();
    const now = Date.now();
    if (cached && now - cached.checkedAt < STAT_REVALIDATE_MS) {
        return cached.doc;
    }
    const { mtimeMs } = await stat(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
        cached.checkedAt = now;
        return cached.doc;
    }
    const content = await readFile(filePath, 'utf8');
    const doc = {
        content,
        updatedAt: new Date(mtimeMs).toISOString(),
        path: filePath,
    };
    setSlot({ doc, mtimeMs, checkedAt: now });
    return doc;
}
async function readContextFromBackend() {
    if (useFirestoreContextBackend()) {
        await ensureContextFile();
        const remote = await readContextFromFirestore();
        if (!remote || remote.content.trim().length < 8) {
            throw new Error('CONTEXT Firestore trống — kiểm tra seed public/CONTEXT.md.');
        }
        const doc = {
            content: remote.content,
            updatedAt: remote.updatedAt,
            path: getContextFilePath(),
        };
        contextDocCache = { doc, mtimeMs: Date.parse(remote.updatedAt) || Date.now(), checkedAt: Date.now() };
        return doc;
    }
    return readDocumentCached(CONTEXT_FILE, ensureContextFile, () => contextDocCache, (v) => {
        contextDocCache = v;
    });
}
export async function readContextDocument() {
    return readContextFromBackend();
}
export async function readImageSamplesDocument() {
    return readDocumentCached(IMAGE_SAMPLES_FILE, ensureImageSamplesFile, () => imageSamplesDocCache, (v) => {
        imageSamplesDocCache = v;
    });
}
function invalidateContextDocCache() {
    contextDocCache = null;
}
/** Ghi CONTEXT — Firestore (mọi instance) + mirror file local cho seed/deploy. */
export async function writeContextDocument(content) {
    const updatedAt = new Date().toISOString();
    if (useFirestoreContextBackend()) {
        await writeContextToFirestore(content, updatedAt);
        await clearSharedContextCacheInFirestore().catch(() => undefined);
        invalidateContextDocCache();
        try {
            await mkdir(DATA_DIR, { recursive: true });
            await writeFile(CONTEXT_FILE, content, 'utf8');
            await writeFile(SEED_FILE, content, 'utf8');
        }
        catch (e) {
            console.warn('[context-store] Không ghi mirror file CONTEXT:', e);
        }
        return readContextFromBackend();
    }
    await ensureContextFile();
    await writeFile(CONTEXT_FILE, content, 'utf8');
    invalidateContextDocCache();
    try {
        await writeFile(SEED_FILE, content, 'utf8');
    }
    catch (e) {
        console.warn('[context-store] Không ghi mirror public/CONTEXT.md:', e);
    }
    return readContextDocument();
}
