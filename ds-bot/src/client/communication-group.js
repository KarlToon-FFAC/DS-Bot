import { createElement as h } from 'react'
import { contactDirectory } from './communication-contacts.js'
import { CommunicationAvatar } from './communication-profile.js'
import { t } from './i18n.js'

export function invitationGroups(invites = []) {
  const groups = new Map()
  for (const invite of invites) {
    // Older snapshots lack a verified source: keep those entries separate.
    const key = JSON.stringify([invite.conversationId, invite.inviterPrincipalId ?? invite.inviteId])
    if (!groups.has(key)) groups.set(key, { ...invite, key, targets: [] })
    groups.get(key).targets.push(invite)
  }
  return [...groups.values()]
}

export function GroupBotChoices({ contacts, humanId, instanceId, selected, onChange, request, single = false }) {
  const { people, otherBots } = contactDirectory(contacts, [], humanId, instanceId)
  const local = contacts.filter(person => person.kind === 'bot' && (humanId && person.ownerPrincipalId === humanId || instanceId && (person.homeInstanceId === instanceId || person.principalId.startsWith(`bot:${instanceId}:`))))
  const self = contacts.find(person => person.principalId === humanId) ?? { principalId: humanId, displayName: t('You'), kind: 'human' }
  const groups = [{ person: self, bots: local }, ...people.filter(item => item.available)]
  if (otherBots.length) groups.push({ person: { displayName: t('Other available Bots') }, bots: otherBots })
  return h('div', { className: 'bt-comm-group-choices' }, groups.map(({ person, bots }, index) => h('section', { key: person.principalId ?? index, className: 'bt-comm-group-contact' },
    h('div', { className: 'bt-comm-group-contact-heading' }, person.principalId ? h(CommunicationAvatar, { person, request, size: 24 }) : null,
      h('strong', null, person.displayName), h('span', { className: 'bt-comm-reference' }, person.ipAddress ?? t('Address unavailable'))),
    bots.map(bot => h('label', { key: bot.principalId, className: 'bt-comm-check' },
      h('input', { type: single ? 'radio' : 'checkbox', name: single ? 'invite-group-bot' : undefined, 'aria-label': `${t('Invite')} ${bot.displayName}`, checked: selected.includes(bot.principalId), onChange: event => onChange(event.target.checked ? single ? [bot.principalId] : [...selected, bot.principalId] : selected.filter(id => id !== bot.principalId)) }),
      h(CommunicationAvatar, { person: bot, request, size: 24 }), h('span', { className: 'bt-comm-choice-name' }, bot.displayName))))),
    h('p', { className: 'bt-comm-reference' }, t('Selected Bots and their owners join the group immediately.')))
}

export function InvitationDetails({ invitation, busy, onAccept }) {
  return invitation ? h('div', { className: 'bt-comm-invitation-details' },
    h('h3', null, invitation.title),
    h('dl', null, h('dt', null, t('Invitation source')), h('dd', null, invitation.inviterName ?? t('Source unavailable')),
      invitation.inviterPrincipalId ? h('dd', null, h('code', null, invitation.inviterPrincipalId)) : null,
      h('dt', null, t('Source address')), h('dd', null, invitation.inviterIpAddress ?? t('Address unavailable')),
      h('dt', null, t('Target group')), h('dd', null, h('code', null, invitation.conversationId))),
    h('h3', null, t('Invited participants')), h('ul', null, invitation.targets.map(target => h('li', { key: target.inviteId }, target.principalName ?? target.principalId, h('code', null, target.principalId)))),
    h('button', { type: 'button', disabled: busy, onClick: onAccept }, t('Accept invitation'))) : h('p', { role: 'status' }, t('This invitation is no longer pending.'))
}

export function groupMemberContacts(members, contacts = []) {
  const humans = members.filter(person => person.kind === 'human')
  const groups = humans.map(person => ({person,bots:[]})), unknown = []
  const owners = new Map(groups.map(group => [group.person.principalId,group]))
  for (const bot of members.filter(person => person.kind === 'bot')) {
    const owner = bot.ownerPrincipalId ?? contacts.find(person => person.principalId === bot.principalId)?.ownerPrincipalId
    const group = owners.get(owner)
    if (group) group.bots.push(bot)
    else unknown.push(bot)
  }
  if (unknown.length) groups.push({person:null,bots:unknown})
  return groups
}
