import { createElement as h } from 'react'
import { t } from './i18n.js'
import { CommunicationAvatar } from './communication-profile.js'
import { contactLabels, conversationTitle } from './communication-model.js'

// The same seats as the local RoomAvatar: two overlapping diagonally, then a
// triangle or four corners. Unlike a local room, each seat may also be a Human.
const seats = (count, size) => count < 2 ? [[0, 0, size]] : count === 2 ? [[0, 0, size * 2 / 3], [size / 3, size / 3, size * 2 / 3]] : count === 3 ? [[size * 2 / 9, 0, size * 5 / 9], [0, size * 4 / 9, size * 5 / 9], [size * 4 / 9, size * 4 / 9, size * 5 / 9]] : [[0, 0, size / 2], [size / 2, 0, size / 2], [0, size / 2, size / 2], [size / 2, size / 2, size / 2]]
export function ConversationAvatar({ conversation, humanId, request, size = 36 }) {
  const members = conversation.info?.members ?? []
  const viewerId = conversation.viewerPrincipalId ?? humanId
  const people = conversation.kind === 'group' ? members : members.filter(person => person.principalId !== viewerId).slice(0, 1)
  if (conversation.kind !== 'group' && people.length) return h(CommunicationAvatar, { person: people[0], request, size })
  if (!people.length) return h('span', { className: 'bt-comm-room-avatar bt-comm-room-empty', style: { width: size, height: size }, 'aria-hidden': true }, h('span', null, '◇'))
  const positions = seats(Math.min(people.length, 4), size), gap = size / 14
  const rings = positions.map(([x, y, width]) => ({ x: x + width / 2, y: y + width / 2, r: width * .48 + gap }))
  return h('span', { className: 'bt-cluster bt-comm-room-avatar', style: { width: size, height: size }, 'aria-hidden': true }, positions.map(([x, y, width], index) => {
    const holes = rings.slice(index + 1).filter(ring => Math.hypot(ring.x - x - width / 2, ring.y - y - width / 2) < ring.r + width * .46).map(ring => `radial-gradient(circle at ${ring.x - x}px ${ring.y - y}px,transparent ${ring.r}px,#000 ${ring.r + .5}px)`)
    const style = { left: x, top: y, width, height: width, ...(holes.length ? { WebkitMaskImage: holes.join(','), maskImage: holes.join(','), WebkitMaskComposite: 'source-in', maskComposite: 'intersect' } : {}) }
    return h('span', { key: people[index].principalId, style }, people.length > 4 && index === 3 ? h('span', { className: 'bt-comm-room-more' }, `+${people.length - 3}`) : h(CommunicationAvatar, { person: people[index], request, size: width }))
  }))
}

export function ConversationRow({ conversation, humanId, labels, selected, request, onChoose, disabled }) {
  const name = conversationTitle(conversation, humanId, labels)
  const preview = conversation.lastMessage?.summary ?? ''
  const author = conversation.lastMessage?.author
  const people = [...(conversation.info?.members ?? []), ...(conversation.info?.formerMembers ?? [])]
  const current = people.find(person => person.principalId === author?.principalId)
  const sender = current ? contactLabels(people).get(current.principalId) : null
  const summary = preview && conversation.kind === 'group' && sender ? `${sender}: ${preview}` : preview
  const accessibleName = [name, summary, conversation.unread > 0 ? `${conversation.unread} ${t('Unread')}` : ''].filter(Boolean).join(', ')
  return h('button', { type: 'button', className: 'bt-comm-conversation-row', disabled, 'aria-label': accessibleName, 'aria-pressed': selected, 'aria-current': selected ? 'page' : undefined,
    title: `${name}\n${conversation.conversationId}`, 'data-conversation-id': conversation.conversationId, onClick: () => onChoose(conversation.conversationId) },
    h(ConversationAvatar, { conversation, humanId, request }),
    h('span', { className: 'bt-row-body bt-comm-conversation-body' }, h('span', { className: 'bt-row-name bt-comm-conversation-name' }, name), h('span', { className: 'bt-row-preview bt-comm-conversation-preview', title: summary }, summary)),
    conversation.unread > 0 ? h('span', { className: 'bt-comm-unread', 'aria-hidden': true }, conversation.unread > 99 ? '99+' : conversation.unread) : null)
}
