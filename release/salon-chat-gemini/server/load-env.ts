import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const i = trimmed.indexOf('=')
    if (i <= 0) continue
    const key = trimmed.slice(0, i).trim()
    const value = trimmed.slice(i + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}
