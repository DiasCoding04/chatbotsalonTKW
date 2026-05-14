import type { IncomingMessage } from 'node:http'

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024

export function readJsonBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<unknown> {
  return readRawBody(req, maxBytes).then((raw) => {
    const text = raw.toString('utf8').trim()
    if (!text) return {}
    return JSON.parse(text) as unknown
  })
}

export function readRawBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0

    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error(`Payload vượt quá ${maxBytes} byte.`))
        req.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })

    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })

    req.on('error', reject)
  })
}
