import type { IncomingMessage } from 'node:http'

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024

export function readJsonBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<unknown> {
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
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })

    req.on('error', reject)
  })
}
