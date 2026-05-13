import type { ChatImage } from './gemini'

export const MAX_CHAT_IMAGES = 4
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const ALLOWED_VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime'])

export function isAllowedImageMime(mime: string): boolean {
  return ALLOWED_MIME.has(mime)
}

export function isAllowedVideoMime(mime: string): boolean {
  return ALLOWED_VIDEO_MIME.has(mime)
}

export async function readImageAttachment(file: File): Promise<ChatImage> {
  const isImage = isAllowedImageMime(file.type)
  const isVideo = isAllowedVideoMime(file.type)
  if (!isImage && !isVideo) {
    throw new Error('Chỉ hỗ trợ ảnh JPEG, PNG, WebP, GIF hoặc video MP4, WebM, MOV.')
  }
  if (isImage && file.size > MAX_IMAGE_BYTES) {
    throw new Error('Ảnh tối đa 4 MB.')
  }
  if (isVideo && file.size > MAX_VIDEO_BYTES) {
    throw new Error('Video tối đa 20 MB.')
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result
      if (typeof dataUrl !== 'string') {
        reject(new Error('Không đọc được file đính kèm.'))
        return
      }
      resolve({ mimeType: file.type, dataUrl })
    }
    reader.onerror = () => reject(new Error('Không đọc được file đính kèm.'))
    reader.readAsDataURL(file)
  })
}
