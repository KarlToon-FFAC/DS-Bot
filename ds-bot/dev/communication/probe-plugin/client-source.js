import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export const inject = ['slots', 'layout']
const PANEL = 'communication-probe'
const request = async body => {
  const response = await fetch('/api/communication-probe', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!result.ok) throw new Error('Local probe is unavailable')
  return result.value
}

export function ProbePane() {
  const [snapshot, setSnapshot] = useState(null)
  const [selected, setSelected] = useState(() => sessionStorage.getItem('p0-conversation') ?? 'p0-group')
  const [drafts, setDrafts] = useState({})
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)
  const input = useRef(null)
  useEffect(() => {
    let active = true
    const refresh = () => request({ operation: 'view' }).then(value => {
      if (active) { setSnapshot(value); setError(null) }
    }).catch(fail => { if (active) setError(fail.message) })
    refresh()
    const timer = setInterval(refresh, 500)
    return () => { active = false; clearInterval(timer) }
  }, [])
  useEffect(() => {
    sessionStorage.setItem('p0-conversation', selected)
    input.current?.focus()
    void request({ operation: 'view-read', conversationId: selected }).catch(fail => setError(fail.message))
  }, [selected, snapshot?.views[selected]?.messages.at(-1)?.messageId])
  const send = async () => {
    const text = drafts[selected]?.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await request({ operation: 'view-send', conversationId: selected, text })
      setDrafts(current => ({ ...current, [selected]: '' }))
      setSnapshot(await request({ operation: 'view' }))
    } catch (fail) { setError(fail.message) } finally { setSending(false); input.current?.focus() }
  }
  const view = snapshot?.views[selected]
  return h('section', { className: 'p0-pane', 'aria-label': 'P0 communication view' },
    h('header', null, h('h2', null, 'P0 communication probe'), h('p', null, 'Local test data · Human notifications and display only')),
    h('nav', { 'aria-label': 'Communication conversations' },
      ['p0-group', 'p0-dm'].map(id => h('button', { key: id, type: 'button', 'aria-pressed': selected === id,
        onClick: () => setSelected(id) }, id === 'p0-group' ? 'Shared group' : 'Private message',
      snapshot?.views[id]?.unread ? h('span', { 'aria-label': `${snapshot.views[id].unread} unread` }, ` (${snapshot.views[id].unread})`) : null))),
    h('h3', null, selected === 'p0-group' ? 'Shared group' : 'Private message'),
    h('div', { className: 'p0-log', role: 'log', 'aria-label': 'Communication messages' },
      (view?.messages ?? []).map(message => h('article', { key: message.messageId },
        h('strong', null, message.author), h('p', null, message.text)))),
    h('label', { htmlFor: 'p0-message' }, 'Message to Human'),
    h('textarea', { id: 'p0-message', ref: input, value: drafts[selected] ?? '', rows: 2,
      onChange: event => setDrafts(current => ({ ...current, [selected]: event.target.value })),
      onKeyDown: event => {
        event.stopPropagation()
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          void send()
        }
      } }),
    h('button', { type: 'button', disabled: sending || !drafts[selected]?.trim(), onClick: () => { void send() } }, 'Send to Human'),
    error ? h('p', { role: 'alert' }, error) : null)
}

export function ProbeOverlay() {
  const [open, setOpen] = useState(() => sessionStorage.getItem('p0-pane-open') === 'true')
  const frame = useRef(null)
  const [layout, setLayout] = useState(false)
  const [layoutWidth, setLayoutWidth] = useState(508)
  useEffect(() => {
    if (!open) return
    // The underlying Bot composer may restore focus after this pane mounts.
    const retainFocus = event => {
      if (frame.current && !frame.current.contains(event.target)) frame.current.querySelector('textarea')?.focus()
    }
    document.addEventListener('focusin', retainFocus, true)
    return () => document.removeEventListener('focusin', retainFocus, true)
  }, [open])
  const select = value => { sessionStorage.setItem('p0-pane-open', String(value)); setOpen(value) }
  return createPortal(h('div', null,
    h('button', { className: 'p0-layout-entry', type: 'button', onClick: () => setLayout(true) }, 'Responsive layout test'),
    layout ? h('section', { className: 'p0-layout-test', 'aria-label': 'Isolated responsive layout test' },
      h('header', null, h('strong', null, `Production iframe viewport ${layoutWidth} × 760`),
        h('label', null, 'Viewport width', h('select', { value: layoutWidth, onChange: event => setLayoutWidth(Number(event.target.value)) },
          [508,700,1024].map(width => h('option', { key: width, value: width }, String(width))))),
        h('button', { type: 'button', onClick: () => setLayout(false) }, 'Close layout test')),
      h('iframe', { title: 'Production communication viewport', src: '/', width: layoutWidth, height: 760, style: { width: layoutWidth, height: 760, border: '1px solid var(--bt-line)' } })) : null,
    open ? h('div', { className: 'p0-frame', ref: frame },
      h('aside', { className: 'p0-navigation', 'aria-label': 'P0 navigation' },
        h('strong', null, 'P0 communication'),
        h('p', null, 'Isolated local test'),
        h('button', { type: 'button', onClick: () => select(false) }, 'Back to Chief')),
      h(ProbePane))
      : h('button', { className: 'p0-entry', type: 'button', onClick: () => select(true) }, 'P0 communication'),
    h('span', { className: 'p0-status', role: 'status' }, 'Local P0 probe')), document.body)
}

const CSS = `body:has(.bt-comm-frame) :is(.p0-layout-entry,.p0-entry){display:none}
.p0-pane{height:100%;min-height:0;display:flex;flex-direction:column;gap:12px;padding:24px;box-sizing:border-box;color:var(--bt-ink);background:var(--bt-main);font:14px/22px var(--bt-font)}
.p0-layout-entry{position:fixed;left:16px;bottom:112px;z-index:61;pointer-events:auto;font:13px var(--bt-font);padding:6px 10px;background:var(--bt-card);color:var(--bt-ink);border:1px solid var(--bt-line);border-radius:8px}.p0-layout-test{position:fixed;inset:0;z-index:70;overflow:auto;background:var(--bt-main);color:var(--bt-ink);padding:16px;pointer-events:auto}.p0-layout-test header{display:flex;align-items:center;gap:16px;padding:8px}.p0-layout-test button,.p0-layout-test select{font:inherit;border:1px solid var(--bt-line);background:var(--bt-card);color:var(--bt-ink);padding:6px;border-radius:8px}.p0-layout-test iframe{display:block;max-width:none;background:var(--bt-main)}
.p0-pane h2,.p0-pane h3,.p0-pane p{margin:0}.p0-pane h2{font-size:18px}.p0-pane h3{font-size:14px}.p0-pane header p{color:var(--bt-ink-2);font-size:12px}.p0-pane nav{display:flex;gap:8px}.p0-pane button,.p0-pane textarea{font:inherit;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);padding:8px 12px}.p0-pane button{cursor:pointer}.p0-pane button[aria-pressed=true]{background:var(--bt-active)}.p0-pane button:disabled{opacity:.5}.p0-log{flex:1;min-height:120px;overflow:auto}.p0-log article{padding:12px;margin-bottom:8px;background:var(--bt-bubble);border-radius:12px}.p0-log article p{white-space:pre-wrap;overflow-wrap:anywhere}.p0-pane textarea:focus-visible,.p0-pane button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}.p0-status{position:fixed;bottom:8px;right:12px;z-index:61;color:var(--bt-ink-2);font-size:11px;pointer-events:none}
.p0-frame{position:fixed;inset:0;z-index:60;display:grid;grid-template-columns:220px minmax(0,1fr);pointer-events:auto;background:var(--bt-main);color:var(--bt-ink);font:14px/22px var(--bt-font)}.p0-navigation{padding:24px;display:flex;flex-direction:column;gap:16px;background:var(--bt-sidebar);border-right:1px solid var(--bt-line)}.p0-navigation p{margin:0}.p0-navigation button,.p0-entry{border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);padding:10px 12px;font:inherit;cursor:pointer}.p0-entry{position:fixed;left:16px;bottom:70px;z-index:60;pointer-events:auto}@media(max-width:600px){.p0-frame{grid-template-columns:140px minmax(0,1fr)}.p0-navigation,.p0-pane{padding:12px}}`

export function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  }, 'communication-probe: styles')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, ProbePane))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, label: 'P0 communication', order: 90 }, () => h('span', null, '↔')))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'p0-communication-status', order: 90 }, ProbeOverlay))
}
