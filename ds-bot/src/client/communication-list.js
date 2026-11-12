import { useActionMenu } from './action-menu.js'
import { createElement as h, useCallback } from 'react'
import { t } from './i18n.js'
import { CommunicationAvatar } from './communication-profile.js'
import { contactLabels, conversationTitle } from './communication-model.js'

// The same seats as the local RoomAvatar: two overlapping diagonally, then a
// triangle or four corners. Unlike a local room, each seat may also be a Human.
const seats = (count, size) => count < 2 ? [[0, 0, size]] : count === 2 ? [[0, 0, size * 2 / 3], [size / 3, size / 3, size * 2 / 3]] : count === 3 ? [[size * 2 / 9, 0, size * 5 / 9], [0, size * 4 / 9, size * 5 / 9], [size * 4 / 9, size * 4 / 9, size * 5 / 9]] : [[0, 0, size / 2], [size / 2, 0, size / 2], [0, size / 2, size / 2], [size / 2, size / 2, size / 2]]
export function ConversationAvatar({ conversation, humanId, request, size = 36 }) {
  const groupId='group:'+conversation.conversationId
  const groupRequest=useCallback(async body=>{
    const value=await request({endpoint:'group-avatar',conversationId:conversation.conversationId,membershipEpoch:conversation.membershipEpoch,revision:body.revision})
    return {...value,principalId:groupId}
  },[request,conversation.conversationId,conversation.membershipEpoch,groupId])
  const members = conversation.info?.members ?? []
  if(conversation.kind==='group'&&conversation.info?.avatar?.imageRevision)return h(CommunicationAvatar,{person:{principalId:groupId,kind:'group',displayName:conversation.title,avatar:conversation.info.avatar},request:groupRequest,size})
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

export function ConversationRow({ conversation, humanId, labels, selected, request, onChoose, disabled, onArchive, onDetails }) {
  const context = useActionMenu()
  const name = conversationTitle(conversation, humanId, labels)
  const preview = conversation.lastMessage?.summary ?? ''
  const author = conversation.lastMessage?.author
  const people = [...(conversation.info?.members ?? []), ...(conversation.info?.formerMembers ?? [])]
  const current = people.find(person => person.principalId === author?.principalId)
  const sender = current ? labels.get(current.principalId) ?? contactLabels(people).get(current.principalId) : null
  const summary = preview && conversation.kind === 'group' && sender ? `${sender}: ${preview}` : preview
  const accessibleName = [name, summary, conversation.unread > 0 ? `${conversation.unread} ${t('Unread')}` : ''].filter(Boolean).join(', ')
  return h('button', { type: 'button', className: 'bt-comm-conversation-row', disabled, 'aria-label': accessibleName, 'aria-pressed': selected, 'aria-current': selected ? 'page' : undefined,
    onContextMenu:event=>context.open(event,[{label:t('Open conversation'),run:()=>onChoose(conversation.conversationId)}, {label:t('Copy conversation ID'),run:()=>navigator.clipboard.writeText(conversation.conversationId)},onDetails&&{label:t('Group settings'),run:()=>onDetails(conversation)},onArchive&&{label:t(conversation.archived?'Restore private chat':'Archive private chat'),run:()=>onArchive(conversation)}]),
    title: `${name}\n${conversation.conversationId}`, 'data-conversation-id': conversation.conversationId, onClick: () => onChoose(conversation.conversationId) },
    context.menu, h(ConversationAvatar, { conversation, humanId, request }),
    h('span', { className: 'bt-row-body bt-comm-conversation-body' }, h('span', { className: 'bt-row-name bt-comm-conversation-name' }, name), h('span', { className: 'bt-row-preview bt-comm-conversation-preview', title: summary }, summary)),
    conversation.unread > 0 ? h('span', { className: 'bt-comm-unread', 'aria-hidden': true }, conversation.unread > 99 ? '99+' : conversation.unread) : null)
}
