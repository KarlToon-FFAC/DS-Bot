import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { contactLabels, referenceExcerpt } from './communication-model.js'
import { CommunicationAvatar } from './communication-profile.js'
import { CommunicationMessage } from './communication-message.js'

// Viewing replies never creates a message, marks unseen main-history pages read,
// or changes the Bot causal budget. Reply uses the existing composer intent.
export function CommunicationThread({ member, messageId, request, canSpeak, onReply, onInspect }) {
  const [page, setPage] = useState(null), [error, setError] = useState(false), [loading, setLoading] = useState(false)
  const order = useRef(0), current = useRef(null)
  current.current = page
  const members = member.info?.members ?? [], labels = contactLabels(members)
  useEffect(() => {
    const token = ++order.current
    setPage(null); setError(false); setLoading(true)
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
  const depth = message => {
    let value = message, count = 0
    const seen = new Set([message.messageId])
    while (messages.has(value.replyToMessageId) && !seen.has(value.replyToMessageId)) {
      seen.add(value.replyToMessageId); value = messages.get(value.replyToMessageId); count += 1
    }
    return Math.min(count, 4)
  }
  return h('div', { className: 'bt-comm-thread' },
    h('p', { className: 'bt-comm-reference' }, t(canSpeak ? 'Replies stay in this conversation. Select Reply to continue an exact message.' : 'Replies stay in this conversation.')),
    page?.earlierUnavailable ? h('p', { role: 'status' }, t('Earlier context is outside your authorized history.')) : null,
    loading ? h('p', { role: 'status' }, t('Loading replies…')) : null,
    error ? h('p', { role: 'status' }, t('This reply chain is unavailable. Reopen it after synchronization.')) : null,
    h('div', { className: 'bt-comm-thread-log', role: 'log', 'aria-label': t('Message replies') }, (page?.events ?? []).map(event => {
      const message = event.message, person = members.find(item => item.principalId === message.author.principalId) ?? { ...message.author, displayName: t('Participant') }
      const parent = messages.get(message.replyToMessageId)
      return h('article', { key: message.messageId, 'data-thread-message-id': message.messageId, 'data-thread-selected': message.messageId === messageId, style: { '--reply-depth': depth(message) } },
        h('div', { className: 'bt-comm-person-label' }, h(CommunicationAvatar, { person, request, allowed: members.includes(person), size: 24 }), h('strong', { title: person.principalId }, labels.get(person.principalId) ?? t('Participant'))),
        parent ? h('p', { className: 'bt-comm-thread-parent' }, t('Reply to'), ' ', labels.get(parent.author.principalId) ?? t('Participant'), ': ', referenceExcerpt(parent.content.text)) : null,
        h('div', { className: 'bt-comm-body' }, h(CommunicationMessage, { message, members, request, onInspect })),
        h('div', { className: 'bt-comm-message-actions' }, h('time', null, new Date(event.serverAcceptedAt).toLocaleString()), canSpeak ? h('button', { type: 'button', onClick: () => onReply(message) }, t('Reply')) : null))
    })),
    page?.hasMore ? h('button', { type: 'button', disabled: loading, onClick: () => { void more() } }, t('Load more replies')) : null)
}
