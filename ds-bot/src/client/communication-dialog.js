import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLinger, SPRING_POP, SPRING_TAP } from './motion.js'
import { CloseIcon } from './icons.js'
import { communicationFailure } from './communication-errors.js'
import { t } from './i18n.js'

// Native top-layer dialogs escape scrolling settings cards and make the page
// behind them inert. The fallback also keeps keyboard focus inside in test hosts.
export function CommunicationDialog({ open, title, onClose, children, actions, busy = false, error, alert = false }) {
  const [shown, closing] = useLinger(open, 160)
  const element = useRef(null), latest = useRef({ onClose, busy })
  latest.current = { onClose, busy }
  useLayoutEffect(() => {
    if (!shown) return undefined
    const node = element.current, trigger = document.activeElement
    if (node.showModal) node.showModal()
    else node.setAttribute('open', '')
    ;(node.querySelector('[data-dialog-cancel]') ?? node.querySelector('button,input,select,textarea') ?? node).focus()
    const keys = event => {
      if (event.target.closest?.('dialog') !== node || event.target.closest?.('[data-action-menu]')) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation()
        if (!latest.current.busy) latest.current.onClose()
      }
      if (event.key === 'Tab') {
        const controls = [...node.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')]
          .filter(item => !item.checkVisibility || item.checkVisibility())
        const first = controls[0], last = controls.at(-1)
        if (!controls.length || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus()
        }
      }
    }
    document.addEventListener('keydown', keys, true)
    return () => {
      document.removeEventListener('keydown', keys, true)
      if (node.close) node.close()
      if (trigger?.isConnected) trigger.focus()
    }
  }, [Boolean(shown)])
  if (!shown) return null
  return createPortal(h('dialog', { ref: element, className: 'bt-comm-frame bt-comm-dialog-layer', role: alert ? 'alertdialog' : 'dialog', 'aria-modal': true, 'aria-label': t(title), tabIndex: -1,
    'data-closing': closing, style: { '--bt-pop-duration': `${SPRING_POP.duration}ms`, '--bt-pop-easing': SPRING_POP.easing, '--bt-tap-duration': `${SPRING_TAP.duration}ms`, '--bt-tap-easing': SPRING_TAP.easing },
    onCancel: event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() },
    onMouseDown: event => { if (event.target === event.currentTarget && !busy) onClose() } },
    h('section', { className: 'bt-comm-modal bt-comm-operation-dialog' },
      h('header', { className: 'bt-comm-operation-heading' }, h('h2', null, t(title)), h('button', { type: 'button', disabled: busy, onClick: onClose, 'aria-label': t('Close dialog'), 'data-dialog-cancel': true }, h(CloseIcon))),
      h('div', { className: 'bt-comm-operation-body' }, children, error ? h('p', { className: 'bt-comm-error', role: 'alert' }, t(error)) : null),
      h('footer', { className: 'bt-comm-operation-footer' }, actions ?? h('button', { type: 'button', disabled: busy, onClick: onClose }, t('Close'))))), document.body)
}

export function CommunicationActionDialog({ open, title, onClose, onConfirm, confirmLabel, children, danger = false, disabled = false, error }) {
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState('')
  const working = useRef(false), live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => { if (open) setFailure('') }, [open])
  const submit = async () => {
    if (working.current || disabled) return
    working.current = true; setBusy(true); setFailure('')
    try {
      const result = await onConfirm()
      if (!live.current) return
      if (result?.status === 'queued') setFailure(t('An operation is not confirmed. Check status, then retry the same action.'))
      else if (result !== false) onClose()
    } catch (failure) { if (live.current) setFailure(communicationFailure(failure)) }
    finally { working.current = false; if (live.current) setBusy(false) }
  }
  return h(CommunicationDialog, { open, title, onClose, busy, error: failure || error, alert: danger,
    actions: h('div', { className: 'bt-comm-operation-buttons' },
      h('button', { type: 'button', disabled: busy, onClick: onClose, 'data-dialog-cancel': true }, t('Cancel')),
      h('button', { type: 'button', disabled: busy || disabled, className: danger ? 'bt-comm-danger' : 'bt-comm-primary', onClick: () => { void submit() } }, t(confirmLabel))) }, children)
}
