import { useActionMenu } from './action-menu.js'
import {BotAvailabilityNotice} from './communication-presence.js'
import { createElement as h, Fragment, useState } from 'react'
import { CommunicationAvatar } from './communication-profile.js'
import { contactLabels } from './communication-model.js'
import { t } from './i18n.js'

export function contactDirectory(contacts, relations = [], humanPrincipalId, instanceId) {
  const people = [...new Map(contacts.map(person => [person.principalId, person])).values()]
  const humans = people.filter(person => person.kind === 'human').sort((a, b) => a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : 0)
  const owners = new Map()
  // Only legacy snapshots lack canonical ownership. A modern null deliberately
  // keeps an unpublished or otherwise invisible owner out of this directory.
  for (const human of humans) if (human.homeInstanceId && !owners.has(human.homeInstanceId)) owners.set(human.homeInstanceId, human.principalId)
  const active = new Map(relations.filter(item => item.active).map(item => [item.otherHumanPrincipalId, item]))
  const directory = new Map(humans.filter(person => person.principalId !== humanPrincipalId).map(person => [person.principalId, { person, available: true, bots: [], relation: active.get(person.principalId) }]))
  for (const [id, relation] of active) if (id !== humanPrincipalId && !directory.has(id)) directory.set(id, { person: { principalId: id, displayName: id, kind: 'human' }, available: false, bots: [], relation })
  const otherBots = []
  for (const bot of people.filter(person => person.kind === 'bot')) {
    const ownerId = Object.hasOwn(bot, 'ownerPrincipalId') ? bot.ownerPrincipalId : owners.get(bot.homeInstanceId)
    if (humanPrincipalId && ownerId === humanPrincipalId || instanceId && (bot.homeInstanceId === instanceId || bot.principalId.startsWith(`bot:${instanceId}:`))) continue
    const owner = directory.get(ownerId)
    if (owner?.available) owner.bots.push(bot)
    else otherBots.push(bot)
  }
  return { people: [...directory.values()], otherBots }
}

const normalized = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase()
const profileValues = profile => [profile?.headline, profile?.summary, ...(Array.isArray(profile?.expertise) ? profile.expertise : [])]
export function contactMatches(person, query, { label } = {}) {
  const needle = normalized(query).trim()
  return !needle || [label, person.displayName, person.principalId, person.instanceLabel, person.homeInstanceId, person.ipAddress,
    ...profileValues(person.publicProfile)].some(value => normalized(value).includes(needle))
}

export function ContactDirectory({ contacts, relations, humanPrincipalId, instanceId, request, busy, onMessage, onRemove, onUsePublished, connectionKnown }) {
  const context = useActionMenu()
  const [query, setQuery] = useState(''), [view, setView] = useState('all')
  const labels = contactLabels(contacts), { people, otherBots } = contactDirectory(contacts, relations, humanPrincipalId, instanceId)
  const needle = query.trim(), matches = person => contactMatches(person, query, { label: labels.get(person.principalId) })
  const shown = people.filter(item => matches(item.person) || item.bots.some(matches))
  const allBots = [...people.flatMap(item => item.bots), ...otherBots]
  const bots = (view === 'bots' ? allBots : otherBots).filter(matches)
  const connection = person => t(connectionKnown === false || typeof person.connected !== 'boolean' ? 'Connection status unavailable' : person.connected ? 'Connected to Hub' : 'Disconnected from Hub')
  const identity = (person, allowed = true) => h('span', { className: 'bt-comm-directory-person' }, h(CommunicationAvatar, { person, request, allowed, size: 36 }),
    h('span', null, h('strong', null, labels.get(person.principalId) ?? person.displayName ?? person.principalId),
      h(BotAvailabilityNotice,{person}),
      person.publicProfile?.headline ? h('span', { className: 'bt-comm-directory-headline' }, person.publicProfile.headline) : null,
      h('small', null, t(person.kind === 'bot' ? 'Bot' : 'Human'), person.homeInstanceId && instanceId ? ` · ${t(person.homeInstanceId === instanceId ? 'Local' : 'Remote')}` : '',
        person.instanceLabel ? ` · ${person.instanceLabel}` : '', ' · ', connection(person))))
  const message = person => onMessage ? h('button', { type: 'button', disabled: busy, 'aria-label': `${t('Message')} ${labels.get(person.principalId) ?? person.displayName}`, onClick: () => onMessage(person.principalId) }, t('Message')) : null
  const profile = person => {
    const value = person.publicProfile, expertise = Array.isArray(value?.expertise) ? value.expertise : []
    return value?.summary || expertise.length ? h('div', { className: 'bt-comm-directory-profile' },
      value.summary ? h('p', { className: 'bt-comm-directory-summary' }, value.summary) : null,
      expertise.length ? h('ul', { className: 'bt-comm-directory-skills', 'aria-label': t('Expertise') }, expertise.map(item => h('li', { key: item }, item))) : null) : null
  }
  const botRow = person => h('li', { key: person.principalId, 'data-principal-id': person.principalId, className: 'bt-comm-directory-bot',onContextMenu:event=>context.open(event,[onMessage&&{label:t('Message'),disabled:busy,run:()=>onMessage(person.principalId)},{label:t('Copy identity'),run:()=>navigator.clipboard.writeText(person.principalId)}]) },
    h('div', { className: 'bt-comm-directory-row' }, identity(person), message(person)), profile(person))
  const filter = (value, label, count) => h('button', { key: value, type: 'button', 'aria-pressed': view === value, 'aria-label': t(label), onClick: () => setView(value) }, t(label), h('span', { className: 'bt-comm-count', 'aria-hidden': true }, count))
  const showPeople = view !== 'bots', showBots = view !== 'contacts'
  return h('section', { className: 'bt-comm-directory bt-comm-directory-list', 'aria-label': t('Connected contacts') },context.menu,
    h('div', { className: 'bt-comm-directory-heading' }, h('h3', null, t('Connected contacts')), h('span', { className: 'bt-comm-count' }, people.length)),
    h('label', { className: 'bt-comm-field' }, t('Find a contact or Bot'), h('input', { type: 'search', value: query, 'aria-label': t('Find a contact or Bot'), onChange: event => setQuery(event.target.value) })),
    h('div', { className: 'bt-comm-directory-filters', role: 'group', 'aria-label': t('Directory filter') }, filter('all', 'All', people.length + allBots.length), filter('contacts', 'Contacts', people.length), filter('bots', 'Published Bots', allBots.length)),
    showPeople ? shown.map(({ person, available, bots: ownedBots, relation }) => {
      const visibleBots = matches(person) ? ownedBots : ownedBots.filter(matches)
      return h('article', { key: person.principalId, className: 'bt-comm-contact-card', 'data-contact-id': person.principalId,onContextMenu:event=>context.open(event,[available&&onMessage&&{label:t('Message'),disabled:busy,run:()=>onMessage(person.principalId)},{label:t('Copy identity'),run:()=>navigator.clipboard.writeText(person.principalId)},relation&&onRemove&&{label:t('Remove contact'),danger:true,disabled:busy,run:()=>onRemove(relation)}]) },
        h('div', { className: 'bt-comm-contact-card-head' }, identity(person, available), available ? message(person) : null),
        !available ? h('p', { className: 'bt-comm-reference', role: 'status' }, t('Contact details are not available in the current directory.')) : null,
        relation?.botSharing === 'none' ? h('p', { className: 'bt-comm-error', role: 'status' }, t('Your contact scope shares no Bots. Group invitations and Bot DMs may be blocked.'), onUsePublished ? h('button', {type:'button',disabled:busy,onClick:()=>onUsePublished(relation)},t('Use published Bots for this contact')) : null) : null,
        relation?.otherBotSharing === 'none' ? h('p', {className:'bt-comm-reference',role:'status'},t('This contact shares no Bots in this relationship. Ask them to enable published Bots.')) : null,
        h('details', { className: 'bt-comm-directory-about', open: Boolean(needle) }, h('summary', null, t('Profile and Bots'), h('span', { className: 'bt-comm-count' }, visibleBots.length)),
          profile(person), h('h4', null, t('Their Bots')),
          visibleBots.length ? h('ul', { className: 'bt-comm-contact-bots' }, visibleBots.map(botRow)) : h('p', { className: 'bt-comm-reference' }, t('No Bots shared with you'))),
        h('details', { className: 'bt-comm-contact-info' }, h('summary', null, t('Contact details')),
          person.homeInstanceId ? h('p', { className: 'bt-comm-reference' }, person.instanceLabel ?? person.homeInstanceId, ' · ', t(person.ipAddress || 'Address unavailable')) : null,
          h('dl', null, h('dt', null, t('Human identity')), h('dd', null, h('code', null, person.principalId)),
            person.homeInstanceId ? h(Fragment, null, h('dt', null, t('Device identity')), h('dd', null, h('code', null, person.homeInstanceId))) : null,
            relation ? h(Fragment, null, relation.botSharing ? h(Fragment,null,h('dt',null,t('Sharing policy')),h('dd',null,t(relation.botSharing==='published'?'Currently and later published Bots':relation.botSharing==='selected'?'Selected Bots':'None'))) : null, h('dt', null, t('Bots you share with this contact')), h('dd', null, (relation.botPrincipalIds ?? []).map(id => labels.get(id) ?? id).join(', ') || t('None'))) : null),
          ownedBots.length ? h('ul', { className: 'bt-comm-bot-identities' }, ownedBots.map(bot => h('li', { key: bot.principalId }, labels.get(bot.principalId) ?? bot.displayName, ': ', h('code', null, bot.principalId)))) : null,
          relation && onRemove ? h('button', { type: 'button', className: 'bt-comm-danger', disabled: busy, onClick: () => onRemove(relation) }, t('Remove contact')) : null))
    }) : null,
    showBots && bots.length ? h('section', { className: 'bt-comm-contact-card bt-comm-directory-bot-list' }, h('h3', null, t(view === 'bots' ? 'Published Bots' : 'Other available Bots')), h('ul', { className: 'bt-comm-contact-bots' }, bots.map(botRow))) : null,
    !(showPeople && shown.length || showBots && bots.length) ? h('p', { className: 'bt-comm-reference', role: 'status' }, t(needle ? 'No matching contacts or Bots.' : view === 'bots' ? 'No Bots shared with you' : 'No contacts yet. Add someone with their user code.')) : null)
}
