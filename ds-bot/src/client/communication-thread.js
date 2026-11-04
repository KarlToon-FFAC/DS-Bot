import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { contactLabels, referenceExcerpt } from './communication-model.js'
import { CommunicationAvatar } from './communication-profile.js'
import { CommunicationMessage } from './communication-message.js'

// Viewing replies never creates a message, marks unseen main-history pages read,
// or changes the Bot causal budget. Reply uses the existing composer intent.
export function CommunicationThread({ member, messageId, request, canSpeak, onReply, onInspect }) {
  const [page, setPage] = useState(null), [error, setError] = useState(false), [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState(new Set())
  const order = useRef(0), current = useRef(null)
  current.current = page
  const members = member.info?.members ?? [], labels = contactLabels(members)
  useEffect(() => {
    const token = ++order.current
    setPage(null); setCollapsed(new Set()); setError(false); setLoading(true)
    void request({ endpoint: 'thread', conversationId: member.conversationId, membershipEpoch: member.membershipEpoch, messageId }).then(value => {
      if (token === order.current && value.conversationId === member.conversationId && value.membershipEpoch === member.membershipEpoch && value.messageId === messageId) setPage(value)
    }).catch(() => { if (token === order.current) { setPage(null); setError(true) } }).finally(() => { if (token === order.current) setLoading(false) })
    return () => { order.current += 1 }
  }, [member.conversationId, member.membershipEpoch, member.watermark, messageId, request])
  const more = async () => {
    if (loading || !page?.hasMore) return
    const token = ++order.current, base = page
    setLoading(true); setError(false)
    try {
      const value = await request({ endpoint: 'thread', conversationId: member.conversationId, membershipEpoch: member.membershipEpoch, messageId, after: page.nextAfter, watermark: page.watermark })
      if (token === order.current && current.current === base && value.conversationId === member.conversationId && value.membershipEpoch === member.membershipEpoch && value.rootMessageId === base.rootMessageId && value.watermark === base.watermark) setPage({ ...value, events: [...base.events, ...value.events] })
    } catch { if (token === order.current) { setPage(null); setError(true) } }
    finally { if (token === order.current) setLoading(false) }
  }
  const messages = new Map((page?.events ?? []).map(event => [event.message.messageId, event.message]))
  const children = new Map()
  for (const event of page?.events ?? []) {
    const parent = event.message.replyToMessageId
    if (!messages.has(parent) || parent === event.message.messageId) continue
    const branch = children.get(parent) ?? []
    branch.push(event); children.set(parent, branch)
  }
  const rendered = new Set()
  const renderBranch = (event, level = 0) => {
    const message = event.message
    if (rendered.has(message.messageId)) return null
    rendered.add(message.messageId)
    const person = members.find(item => item.principalId === message.author.principalId) ?? { ...message.author, displayName: t('Participant') }
    const parent = messages.get(message.replyToMessageId)
    const replies = (children.get(message.messageId) ?? []).filter(child => !rendered.has(child.message.messageId))
    const hidden = collapsed.has(message.messageId)
    return h('li', { key: message.messageId, 'data-thread-depth': level, 'data-thread-deep': level > 4 || undefined },
      h('article', { 'data-thread-message-id': message.messageId, 'data-thread-selected': message.messageId === messageId, style: { '--reply-depth': Math.min(level, 4) } },
        h('div', { className: 'bt-comm-person-label' }, h(CommunicationAvatar, { person, request, allowed: members.includes(person), size: 24 }), h('strong', { title: person.principalId }, labels.get(person.principalId) ?? t('Participant'))),
        parent ? h('p', { className: 'bt-comm-thread-parent' }, t('Reply to'), ' ', labels.get(parent.author.principalId) ?? t('Participant'), ': ', referenceExcerpt(parent.content.text)) : null,
        h('div', { className: 'bt-comm-body' }, h(CommunicationMessage, { message, members, request, onInspect })),
        h('div', { className: 'bt-comm-message-actions' }, h('time', null, new Date(event.serverAcceptedAt).toLocaleString()), canSpeak ? h('button', { type: 'button', onClick: () => onReply(message) }, t('Reply')) : null,
          replies.length ? h('button', { type: 'button', 'aria-expanded': !hidden, onClick: () => setCollapsed(old => { const next = new Set(old); if (hidden) next.delete(message.messageId); else next.add(message.messageId); return next }) }, t(hidden ? 'Show {count} replies' : 'Hide replies', { count: replies.length })) : null)),
      replies.length && !hidden ? h('ol', { className: 'bt-comm-thread-branches' }, replies.map(child => renderBranch(child, level + 1))) : null)
  }
  const roots = (page?.events ?? []).filter(event => !messages.has(event.message.replyToMessageId) || event.message.replyToMessageId === event.message.messageId)
  return h('div', { className: 'bt-comm-thread' },
    h('p', { className: 'bt-comm-reference' }, t(canSpeak ? 'Replies stay in this conversation. Select Reply to continue an exact message.' : 'Replies stay in this conversation.')),
    page?.earlierUnavailable ? h('p', { role: 'status' }, t('Earlier context is outside your authorized history.')) : null,
    loading ? h('p', { role: 'status' }, t('Loading replies…')) : null,
    error ? h('p', { role: 'status' }, t('This reply chain is unavailable. Reopen it after synchronization.')) : null,
    h('div', { className: 'bt-comm-thread-log', role: 'log', 'aria-label': t('Message replies') },
      h('ol', { className: 'bt-comm-thread-roots' }, roots.map(event => renderBranch(event)))),
    page?.hasMore ? h('button', { type: 'button', disabled: loading, onClick: () => { void more() } }, t('Load more replies')) : null)
}
