/** Phân loại tin trong inbox: khách, AI tự động, hoặc người gửi từ fanpage (nhân viên / Meta Business Suite). */
export type FacebookMessageAuthor = 'customer' | 'ai' | 'staff'

const AI_OUTBOUND_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_PERSISTED_AI_MESSAGE_IDS = 500
const aiOutboundMessageIds = new Map<string, number>()

function pruneAiOutboundIds(): void {
  const now = Date.now()
  for (const [id, expires] of aiOutboundMessageIds) {
    if (expires <= now) aiOutboundMessageIds.delete(id)
  }
}

export function registerAiOutboundMessageId(messageId: string): void {
  const id = messageId.trim()
  if (!id) return
  aiOutboundMessageIds.set(id, Date.now() + AI_OUTBOUND_TTL_MS)
  if (aiOutboundMessageIds.size > 5000) pruneAiOutboundIds()
}

export function isAiOutboundMessageId(messageId: string | undefined): boolean {
  const id = messageId?.trim()
  if (!id) return false
  const expires = aiOutboundMessageIds.get(id)
  if (!expires) return false
  if (Date.now() > expires) {
    aiOutboundMessageIds.delete(id)
    return false
  }
  return true
}

/** Chuẩn hóa author cũ (page/system) và nhận diện tin AI qua message_id Graph. */
export function normalizeStoredMessageAuthor(
  author: string | undefined,
  messageId?: string,
): FacebookMessageAuthor {
  const raw = (author ?? '').trim().toLowerCase()
  if (raw === 'ai' || raw === 'system') return 'ai'
  if (raw === 'staff' || raw === 'page') {
    return isAiOutboundMessageId(messageId) ? 'ai' : 'staff'
  }
  if (isAiOutboundMessageId(messageId)) return 'ai'
  return 'customer'
}

export function isSalonOutboundAuthor(author: string | undefined): boolean {
  const n = normalizeStoredMessageAuthor(author)
  return n === 'ai' || n === 'staff'
}

/** Lưu message_id Graph do AI gửi — dùng trên Firestore (Cloud Run nhiều instance). */
export function rememberAiMessageId(ids: string[] | undefined, messageId: string): string[] {
  const id = messageId.trim()
  if (!id) return ids ?? []
  const next = [...(ids ?? [])]
  if (!next.includes(id)) next.push(id)
  return next.slice(-MAX_PERSISTED_AI_MESSAGE_IDS)
}

export function isStoredAiMessageId(
  persistedIds: string[] | undefined,
  messageId: string | undefined,
): boolean {
  const id = messageId?.trim()
  if (!id) return false
  if (persistedIds?.includes(id)) return true
  return isAiOutboundMessageId(id)
}
