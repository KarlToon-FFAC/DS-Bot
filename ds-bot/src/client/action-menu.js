import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscape } from './overlay-hooks.js'
import { useLinger, useViewport, viewBottom } from './motion.js'
import { t } from './i18n.js'

// Keep editable controls, links, images and selected text on the native menu.
export function nativeContextTarget(target) {
  return target instanceof window.Element && Boolean(target.closest('input,textarea,select,[contenteditable=true],a,video,canvas,pre,code') || target.closest('img') && !target.closest('.bt-comm-avatar-button,.bt-lead,.bt-comm-directory-identity')) || Boolean(window.getSelection()?.toString())
}
export function useActionMenu() {
  const [shown, setShown] = useState(null)
  const [menu, leaving] = useLinger(shown, 120)
  const open = (event, items) => {
    if (event.defaultPrevented || nativeContextTarget(event.target)) return
    const available = items.filter(Boolean)
    if (!available.length) return
    event.preventDefault(); event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setShown({ x: event.clientX || rect.left, y: event.clientY || rect.bottom, items: available, anchor: event.currentTarget })
  }
  return { open, menu: menu ? createPortal(h(ActionMenu, { menu, leaving, close: () => setShown(null) }), menu.anchor.closest('dialog[open],[role=dialog],[role=alertdialog]') ?? document.body) : null }
}
function ActionMenu({ menu, leaving, close }) {
  const ref = useRef(), [place, setPlace] = useState({ left: menu.x, top: menu.y }), [error, setError] = useState('')
  const tick = useViewport()
  const dismiss = () => { close(); if (menu.anchor.isConnected) menu.anchor.focus?.({ preventScroll: true }) }
  useEscape(dismiss)
  useLayoutEffect(() => {
    const box = ref.current.getBoundingClientRect()
    setPlace({ left: Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(menu.y, viewBottom() - box.height - 8)) })
    ref.current.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [menu, tick])
  useEffect(() => {
    const down = event => { if (!ref.current?.contains(event.target)) close() }
    const scroll = event => { if (!ref.current?.contains(event.target)) close() }
    window.addEventListener('pointerdown', down); window.addEventListener('scroll', scroll, true)
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('scroll', scroll, true) }
  }, [close])
  const key = event => {
    const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')], at = buttons.indexOf(document.activeElement)
    const next = event.key === 'ArrowDown' ? (at + 1) % buttons.length : event.key === 'ArrowUp' ? (at - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null
    if (next !== null) { event.preventDefault(); buttons[next]?.focus() }
    if (event.key === 'Tab') close()
  }
  return h('div', { ref, className: 'bt-menu', 'data-action-menu': true, role: 'menu', 'aria-label': t('Actions'), style: { ...place, position: 'fixed', zIndex: 10000, maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }, 'data-leaving': leaving || undefined, onKeyDown: key, onClick: event => event.stopPropagation(), onContextMenu: event => {event.preventDefault();event.stopPropagation()} },
    menu.items.map((item, index) => h('button', { key: index, type: 'button', role: 'menuitem', disabled: leaving || item.disabled, className: item.danger ? 'bt-danger' : undefined, onClick: async () => {
      try { await item.run(menu.anchor); close() } catch { setError(t('Action failed. Please try again.')) }
    } }, item.label)), error ? h('p', { role: 'alert' }, error) : null)
}

// Actions are taken from the current row, so their permission/busy checks and
// confirmation dialogs remain the same as the visible controls.
export function useRowActionMenu(ref, selector, extras = []) {
  const context = useActionMenu(), latest = useRef()
  latest.current = { context, extras }
  useEffect(() => {
    const row = selector ? ref.current?.closest(selector) : ref.current
    if (!row) return
    const open = event => {
      const buttons = [...row.querySelectorAll('[data-context-action]')].filter(button => !button.disabled)
      latest.current.context.open(event, [...buttons.map(button => ({ label: button.getAttribute('aria-label') || button.title || button.textContent, danger: button.className.includes('danger'), run: () => { if (button.isConnected && !button.disabled) button.click() } })), ...latest.current.extras])
    }
    row.addEventListener('contextmenu', open)
    return () => row.removeEventListener('contextmenu', open)
  }, [ref, selector])
  return context.menu
}
