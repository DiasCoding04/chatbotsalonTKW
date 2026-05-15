const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
export function readJsonBody(req, maxBytes = DEFAULT_MAX_BYTES) {
    return readRawBody(req, maxBytes).then((raw) => {
        const text = raw.toString('utf8').trim();
        if (!text)
            return {};
        return JSON.parse(text);
    });
}
export function readRawBody(req, maxBytes = DEFAULT_MAX_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new Error(`Payload vượt quá ${maxBytes} byte.`));
                req.destroy();
                return;
            }
            chunks.push(Buffer.from(chunk));
        });
        req.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
        req.on('error', reject);
    });
}
