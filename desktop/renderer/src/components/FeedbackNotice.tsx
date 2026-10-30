import { useEffect, useRef } from 'react'
import { h } from 'vue'
import { ElMessage } from 'element-plus'
import { publicError } from '../lib/publicError'
import { useLang } from '../i18n'

/** React surfaces share the canvas message stack and presentation. */
export default function FeedbackNotice({ message, error = true, action, onAction, onClose }: {
  message: string; error?: boolean; action?: string; onAction?: () => void; onClose?: () => void
}) {
  const { lang } = useLang()
  const displayMessage = error ? publicError(message, undefined, lang) : message
  const handlers = useRef({ onAction, onClose })
  handlers.current = { onAction, onClose }
  useEffect(() => {
    if (!message) return
    let active = true
    const notice = ElMessage({
      message: h('div', { class: 'feedback-notice-content' }, [
        h('span', displayMessage),
        ...(action ? [h('button', { type: 'button', class: 'feedback-notice-action', onClick: () => handlers.current.onAction?.() }, action)] : []),
      ]),
      type: error ? 'error' : 'info', offset: 64, showClose: error,
      duration: error ? 0 : 4000,
      onClose: () => { if (active) handlers.current.onClose?.() },
    })
    return () => { active = false; notice.close() }
  }, [message, displayMessage, error, action, lang])
  return null
}
