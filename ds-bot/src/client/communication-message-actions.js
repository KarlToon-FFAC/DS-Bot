import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { CopyIcon, CheckIcon, ReplyIcon, ChatsIcon } from './icons.js'

// Shared by the main timeline and reply chain; touch and keyboard users retain
// the same actions as hover users. Copy never changes read state or sends text.
export function CommunicationMessageActions({ message, onReply, onThread, children }) {
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false)
  const timer = useRef(), mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimeout(timer.current) }
  }, [])
  const button = (label, Icon, onClick) => h('button', { type: 'button', className: 'bt-tool', title: t(label), 'aria-label': t(label), onClick }, h(Icon))
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(message.content.text)
      if (!mounted.current) return
      setCopied(true); setFailed(false); clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1200)
    } catch { if (mounted.current) setFailed(true) }
  }
  return h('div', { className: 'bt-comm-message-actions' }, children,
    button(copied ? 'Copied' : 'Copy', copied ? CheckIcon : CopyIcon, () => { void copy() }),
    onReply ? button('Reply', ReplyIcon, event => onReply(message, event.currentTarget)) : null,
    onThread ? button('View replies', ChatsIcon, event => onThread(message, event.currentTarget)) : null,
    failed ? h('span', { role: 'status' }, t('Copy failed. Select the message text to copy it.')) : null)
}
