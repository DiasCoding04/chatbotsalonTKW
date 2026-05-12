import { useEffect, useState } from 'react'
import {
  readStoredContextEditToken,
  saveServerContext,
  storeContextEditToken,
  type ContextApiDocument,
} from '../lib/context-api'

type Props = {
  open: boolean
  initialContent: string
  requiresEditToken: boolean
  onClose: () => void
  onSaved: (doc: ContextApiDocument) => void
}

export function ContextEditor({
  open,
  initialContent,
  requiresEditToken,
  onClose,
  onSaved,
}: Props) {
  const [draft, setDraft] = useState(initialContent)
  const [editToken, setEditToken] = useState(() => readStoredContextEditToken())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(initialContent)
    setError(null)
    setEditToken(readStoredContextEditToken())
  }, [open, initialContent])

  if (!open) return null

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      storeContextEditToken(editToken)
      const doc = await saveServerContext(draft, editToken)
      onSaved(doc)
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="context-editor-backdrop" role="presentation" onClick={onClose}>
      <div
        className="context-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-editor-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="context-editor-head">
          <div>
            <h2 id="context-editor-title">Sửa CONTEXT.md trên server</h2>
            <p className="context-editor-sub">
              Lưu xong server tạo lại Context Cache Gemini cho mọi người dùng.
            </p>
          </div>
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Đóng
          </button>
        </div>

        {requiresEditToken && (
          <label className="context-editor-token">
            <span>Mã chỉnh sửa</span>
            <input
              type="password"
              value={editToken}
              onChange={(e) => setEditToken(e.target.value)}
              placeholder="CONTEXT_EDITOR_TOKEN trên server"
              autoComplete="off"
            />
          </label>
        )}

        <textarea
          className="context-editor-body"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />

        {error && <div className="banner error context-editor-error">{error}</div>}

        <div className="context-editor-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Hủy
          </button>
          <button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu CONTEXT'}
          </button>
        </div>
      </div>
    </div>
  )
}
