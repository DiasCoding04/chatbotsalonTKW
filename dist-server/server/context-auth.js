export function contextEditTokenRequired() {
    return Boolean(process.env.CONTEXT_EDITOR_TOKEN?.trim());
}
export function verifyContextEditToken(req) {
    const required = process.env.CONTEXT_EDITOR_TOKEN?.trim();
    if (!required)
        return true;
    const header = req.headers['x-context-edit-token'];
    if (typeof header === 'string' && header.trim() === required)
        return true;
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        return auth.slice('Bearer '.length).trim() === required;
    }
    return false;
}
