import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const DATA_DIR = process.env.CONTEXT_DATA_DIR?.trim() || resolve(process.cwd(), 'data')
const CONTEXT_FILE =
  process.env.CONTEXT_DATA_PATH?.trim() || resolve(DATA_DIR, 'CONTEXT.md')
const IMAGE_SAMPLES_FILE =
  process.env.IMAGE_SAMPLES_DATA_PATH?.trim() || resolve(DATA_DIR, 'IMAGE_SAMPLES.md')
const SEED_FILE = resolve(process.cwd(), 'public', 'CONTEXT.md')
const IMAGE_SAMPLES_SEED_FILE = resolve(process.cwd(), 'public', 'IMAGE_SAMPLES.md')

export type ContextDocument = {
  content: string
  updatedAt: string
  path: string
}

export function getContextFilePath(): string {
  return CONTEXT_FILE
}

async function seedFile(target: string, seed: string, fallback: string): Promise<void> {
  try {
    await access(target)
    return
  } catch {
    // Seed from public files when the server copy does not exist yet.
  }

  try {
    const content = await readFile(seed, 'utf8')
    await writeFile(target, content, 'utf8')
    return
  } catch {
    await writeFile(target, fallback, 'utf8')
  }
}

export async function ensureContextFile(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await seedFile(CONTEXT_FILE, SEED_FILE, '# Salon context\n\n')
}

export async function ensureImageSamplesFile(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })
  await seedFile(IMAGE_SAMPLES_FILE, IMAGE_SAMPLES_SEED_FILE, '# Image samples\n\n')
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

export async function readImageSamplesDocument(): Promise<ContextDocument> {
  await ensureImageSamplesFile()
  const content = await readFile(IMAGE_SAMPLES_FILE, 'utf8')
  const { mtimeMs } = await stat(IMAGE_SAMPLES_FILE)
  return {
    content,
    updatedAt: new Date(mtimeMs).toISOString(),
    path: IMAGE_SAMPLES_FILE,
  }
}

export async function writeContextDocument(content: string): Promise<ContextDocument> {
  await ensureContextFile()
  await writeFile(CONTEXT_FILE, content, 'utf8')
  return readContextDocument()
}
