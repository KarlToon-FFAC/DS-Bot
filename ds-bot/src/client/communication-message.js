import { randomId } from './random-id.js'
import { createElement as h, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from './dsh-primitives.js'
import { mdLabels } from './btw.js'
import { t } from './i18n.js'
import { contactLabels, messageMentionSpans } from './communication-model.js'
import { CommunicationAvatar } from './communication-profile.js'
import { CommunicationAttachments } from './communication-attachments.js'

// A random component namespace makes authored links incapable of impersonating a
// structured mention. Only anchors produced by our exact span mapping become chips.
export function CommunicationMessage({ message, members, request, onInspect }) {
  const [namespace] = useState(() => { try { return randomId() } catch { return null } }), wrapper = useRef(null)
  const [slots, setSlots] = useState([])
  const labels = contactLabels(members)
  const projection = useMemo(() => {
    const spans = namespace ? messageMentionSpans(message, members) : []
    let text = '', start = 0
    const entries = spans.map((span, index) => {
      const url = `https://remote-mentions.dsbot.invalid/${namespace}/${index}`
      text += message.content.text.slice(start, span.start) + `[\u2060](${url})`
      start = span.end
      return { ...span, url }
    })
    return { text: text + message.content.text.slice(start), entries }
  }, [message, members])
  useLayoutEffect(() => {
    const entries = projection.entries.flatMap(entry => {
      const node = [...wrapper.current.querySelectorAll('a')].find(anchor => anchor.getAttribute('href') === entry.url || anchor.dataset.remoteMention === entry.url)
      if (!node) return []
      node.removeAttribute('href')
      node.dataset.remoteMention = entry.url
      node.classList.add('bt-comm-inline-mention')
      node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0')
      const label = entry.all ? t('All Bots') : labels.get(entry.people[0].principalId)
      node.setAttribute('aria-label', `${t('View participant')}: ${label}`)
      node.title = entry.people.map(person => `${person.displayName} (${person.principalId})`).join(', ')
      return [{ ...entry, node, label }]
    })
    setSlots(entries)
  }, [projection]) // Labels change with the member projection.
  // Some canonical targets cannot safely be bound to a text occurrence (renames,
  // ambiguous names, or a manually selected Human). Keep those exact authorized
  // targets visible without rewriting or guessing at the original message text.
  const covered = new Set(slots.flatMap(slot => slot.people.map(person => person.principalId)))
  const selected = new Set((message.mentions ?? []).map(value => typeof value === 'string' ? value : value.principalId))
  const unmatched = [...new Map(members.filter(person => selected.has(person.principalId) && !covered.has(person.principalId)).map(person => [person.principalId, person])).values()]
  const activate = event => {
    const slot = slots.find(entry => entry.node.contains(event.target))
    if (!slot) return
    event.preventDefault(); event.stopPropagation()
    if (event.type === 'click' || event.type === 'keydown' && ['Enter', ' '].includes(event.key)) onInspect(slot.people.map(person => person.principalId))
  }
  return h('div', { ref: wrapper, onClickCapture: activate, onAuxClickCapture: activate, onContextMenuCapture: activate, onKeyDownCapture: event => { if (['Enter', ' '].includes(event.key)) activate(event) } },
    h(MarkdownText, { text: projection.text, labels: mdLabels(), variant: 'compact' }),
    message.attachments?.length ? h(CommunicationAttachments, { files:message.attachments }) : null,
    slots.map(slot => createPortal(h('span', { className: 'bt-comm-inline-mention-content', 'aria-hidden': true },
      slot.all ? null : h(CommunicationAvatar, { person: slot.people[0], request, size: 16 }), h('span', { className: 'bt-comm-mention-label' }, slot.label)), slot.node, slot.url)),
    unmatched.length ? h('span', { className: 'bt-comm-mention-targets' }, unmatched.map(person => h('button', { type: 'button', key: person.principalId,
      className: 'bt-comm-inline-mention bt-comm-unmatched-mention', 'data-mention-principal-id': person.principalId,
      title: `${person.displayName} (${person.principalId})`, 'aria-label': `${t('View participant')}: ${labels.get(person.principalId)}`, onClick: () => onInspect([person.principalId]) },
      h('span', { className: 'bt-comm-inline-mention-content', 'aria-hidden': true }, h(CommunicationAvatar, { person, request, size: 16 }), h('span', { className: 'bt-comm-mention-label' }, labels.get(person.principalId)))))) : null)
}

export function BotWorkStatus({ event, members, request, onInspect }) {
  // A removed member's identity is never recovered from another conversation's directory.
  const person = members.find(member => member.principalId === event.principalId && member.kind === 'bot')
  const name = person ? contactLabels(members).get(person.principalId) : t('Bot')
  const label = t(event.type === 'bot.work.completed' ? '{name} finished without a reply' : '{name} started on it', { name })
  const content = [h(CommunicationAvatar, { key: 'avatar', person: person ?? { principalId: 'bot:unknown', kind: 'bot', displayName: t('Bot') }, request, size: 16 }), h('span', { key: 'label' }, label)]
  return h('div', { className: 'bt-comm-work-started', 'data-work-event-id': event.eventId }, person ? h('button', { type: 'button', title: person.principalId, 'aria-label': `${label} · ${t('View participant')}`, onClick: () => onInspect([person.principalId]) }, ...content) : h('span', null, ...content))
}
