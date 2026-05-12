import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const DATA_DIR = process.env.CONTEXT_DATA_DIR?.trim() || resolve(process.cwd(), 'data')
const CONTEXT_FILE =
  process.env.CONTEXT_DATA_PATH?.trim() || resolve(DATA_DIR, 'CONTEXT.md')
const SEED_FILE = resolve(process.cwd(), 'public', 'CONTEXT.md')

export type ContextDocument = {
  content: string
  updatedAt: string
  path: string
}

export function getContextFilePath(): string {
  return CONTEXT_FILE
}

export async function ensureContextFile(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  try {
    await access(CONTEXT_FILE)
    return
  } catch {
    // Seed from public/CONTEXT.md when the server copy does not exist yet.
  }

  try {
    const seed = await readFile(SEED_FILE, 'utf8')
    await writeFile(CONTEXT_FILE, seed, 'utf8')
    return
  } catch {
    await writeFile(CONTEXT_FILE, '# Salon context\n\n', 'utf8')
  }
}

export async function readContextDocument(): Promise<ContextDocument> {
  await ensureContextFile()
  const content = await readFile(CONTEXT_FILE, 'utf8')
  const { mtimeMs } = await stat(CONTEXT_FILE)
  return {
    content,
    updatedAt: new Date(mtimeMs).toISOString(),
    path: CONTEXT_FILE,
  }
}

export async function writeContextDocument(content: string): Promise<ContextDocument> {
  await ensureContextFile()
  await writeFile(CONTEXT_FILE, content, 'utf8')
  return readContextDocument()
}
