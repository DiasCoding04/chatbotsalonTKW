import type { ChatImage } from './gemini'

export const MAX_CHAT_IMAGES = 4
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export function isAllowedImageMime(mime: string): boolean {
  return ALLOWED_MIME.has(mime)
}

export async function readImageAttachment(file: File): Promise<ChatImage> {
  if (!isAllowedImageMime(file.type)) {
    throw new Error('Chỉ hỗ trợ ảnh JPEG, PNG, WebP hoặc GIF.')
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('Ảnh tối đa 4 MB.')
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result
      if (typeof dataUrl !== 'string') {
        reject(new Error('Không đọc được ảnh.'))
        return
      }
      resolve({ mimeType: file.type, dataUrl })
    }
    reader.onerror = () => reject(new Error('Không đọc được ảnh.'))
    reader.readAsDataURL(file)
  })
}
