import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'

/**
 * Bong bóng AI đang stream — tách khỏi App để:
 *  1) Mỗi delta chỉ re-render chính component này, KHÔNG re-render cả list messages.
 *  2) Gom nhiều delta trong 1 frame (requestAnimationFrame) → tối đa ~60 setState/s
 *     thay vì hàng trăm. Vẫn cảm giác chữ chạy mượt vì mắt không phân biệt.
 */
export type StreamingBubbleHandle = {
  append: (delta: string) => void
  reset: () => void
  /** Trả về toàn bộ text đã nhận (kể cả phần đang chờ flush). */
  getText: () => string
}

export const StreamingBubble = forwardRef<StreamingBubbleHandle>(function StreamingBubble(
  _props,
  ref,
) {
  const [text, setText] = useState('')
  /** Phần delta chưa flush ra state. */
  const pendingRef = useRef('')
  /** Toàn bộ text đã thấy (ref để getText() lấy ngay không chờ render). */
  const textRef = useRef('')
  const rafRef = useRef<number | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  const flush = useCallback(() => {
    rafRef.current = null
    if (!pendingRef.current) return
    textRef.current += pendingRef.current
    pendingRef.current = ''
    setText(textRef.current)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      append(delta: string) {
        if (!delta) return
        pendingRef.current += delta
        if (rafRef.current == null) {
          rafRef.current = requestAnimationFrame(flush)
        }
      },
      reset() {
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = null
        }
        pendingRef.current = ''
        textRef.current = ''
        setText('')
      },
      getText() {
        // Gộp phần đang chờ để caller có text "mới nhất" sau khi stream kết thúc.
        if (pendingRef.current) {
          textRef.current += pendingRef.current
          pendingRef.current = ''
        }
        return textRef.current
      },
    }),
    [flush],
  )

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Tự cuộn xuống cuối khi text mới đến (chỉ ảnh hưởng nội tại bubble, không lan ra App).
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [text])

  return (
    <div className="msg model streaming">
      <div className="role">AI</div>
      {text}
      <span className="stream-caret" aria-hidden />
      <div ref={endRef} />
    </div>
  )
})
