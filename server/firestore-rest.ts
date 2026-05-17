import { clearVertexAccessTokenCache, getVertexAccessToken } from './vertex-auth.ts'

export function resolveFirestoreProjectId(): string {
  return (
    process.env.CONTEXT_FIRESTORE_PROJECT_ID?.trim() ||
    process.env.FACEBOOK_STORE_FIRESTORE_PROJECT_ID?.trim() ||
    process.env.VERTEX_AI_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    ''
  )
}

export function resolveFirestoreDatabase(): string {
  return (
    process.env.CONTEXT_FIRESTORE_DATABASE?.trim() ||
    process.env.FACEBOOK_STORE_FIRESTORE_DATABASE?.trim() ||
    '(default)'
  )
}

export function resolveFirestoreCollection(): string {
  return (
    process.env.CONTEXT_FIRESTORE_COLLECTION?.trim() ||
    process.env.FACEBOOK_STORE_FIRESTORE_COLLECTION?.trim() ||
    'salon_chat'
  )
}

export function contextFirestoreDocId(): string {
  return process.env.CONTEXT_FIRESTORE_DOC_ID?.trim() || 'salon_context'
}

export function contextFirestoreDocName(): string {
  const project = resolveFirestoreProjectId()
  if (!project) throw new Error('Thiếu Firestore project id cho CONTEXT.')
  const database = resolveFirestoreDatabase()
  const collection = resolveFirestoreCollection()
  return `projects/${project}/databases/${database}/documents/${collection}/${contextFirestoreDocId()}`
}

export function contextFirestoreDocUrl(): string {
  return `https://firestore.googleapis.com/v1/${contextFirestoreDocName()}`
}

export function firestoreCommitUrl(): string {
  const project = resolveFirestoreProjectId()
  const database = resolveFirestoreDatabase()
  return `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents:commit`
}

export async function fetchFirestoreWithAuth(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let token = await getVertexAccessToken()
  let res = await fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  })
  if (res.status !== 401) return res

  clearVertexAccessTokenCache()
  token = await getVertexAccessToken()
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  })
}
