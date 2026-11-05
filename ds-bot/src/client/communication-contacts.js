import { createElement as h, Fragment, useState } from 'react'
import { CommunicationAvatar } from './communication-profile.js'
import { contactLabels } from './communication-model.js'
import { t } from './i18n.js'
import { normalizeIpAddress } from '../shared/ip-address.js'

export function contactDirectory(contacts, relations = [], humanPrincipalId) {
  const people = [...new Map(contacts.map(person => [person.principalId, person])).values()]
  const humans = people.filter(person => person.kind === 'human').sort((a, b) => a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : 0)
  const owners = new Map()
  // Legacy instances can have several Humans. Match the Hub's first stable Human
  // ownership rule, never a display name or shared IP address.
  for (const human of humans) if (human.homeInstanceId && !owners.has(human.homeInstanceId)) owners.set(human.homeInstanceId, human.principalId)
  const active = new Map(relations.filter(item => item.active).map(item => [item.otherHumanPrincipalId, item]))
  const directory = new Map(humans.filter(person => person.principalId !== humanPrincipalId).map(person => [person.principalId, { person, available: true, bots: [], relation: active.get(person.principalId) }]))
  for (const [id, relation] of active) if (id !== humanPrincipalId && !directory.has(id)) directory.set(id, { person: { principalId: id, displayName: id, kind: 'human' }, available: false, bots: [], relation })
  const otherBots = []
  for (const bot of people.filter(person => person.kind === 'bot')) {
    const owner = directory.get(owners.get(bot.homeInstanceId))
    if (owner) owner.bots.push(bot)
    else otherBots.push(bot)
  }
  return { people: [...directory.values()], otherBots }
}

export function ContactDirectory({ contacts, relations, humanPrincipalId, instanceId, request, busy, onMessage, onRemove, confirm, addressNotes = {} }) {
  const [query, setQuery] = useState('')
  const labels = contactLabels(contacts), { people, otherBots } = contactDirectory(contacts, relations, humanPrincipalId)
  const needle = query.trim().toLocaleLowerCase()
  const matches = person => [labels.get(person.principalId), person.displayName, person.principalId, person.instanceLabel, person.homeInstanceId, person.ipAddress, addressNotes[normalizeIpAddress(person.ipAddress)]].some(value => value?.toLocaleLowerCase().includes(needle))
  const shown = people.filter(item => matches(item.person) || item.bots.some(matches)), bots = otherBots.filter(matches)
  const identity = (person, allowed = true) => h('span', { className: 'bt-comm-directory-person' }, h(CommunicationAvatar, { person, request, allowed }),
    h('span', null, h('strong', null, labels.get(person.principalId) ?? person.displayName ?? person.principalId), h('small', null, t(person.kind === 'bot' ? 'Bot' : 'Human'), person.homeInstanceId && instanceId ? ` · ${t(person.homeInstanceId === instanceId ? 'Local' : 'Remote')}` : '', person.kind === 'bot' && person.homeInstanceId ? ` · ${person.instanceLabel ?? person.homeInstanceId}` : '')))
  const message = person => onMessage ? h('button', { type: 'button', disabled: busy, 'aria-label': `${t('Message')} ${labels.get(person.principalId) ?? person.displayName}`, onClick: () => onMessage(person.principalId) }, t('Message')) : null
  const botRow = person => h('li', { key: person.principalId, 'data-principal-id': person.principalId }, identity(person), message(person))
  return h('section', { className: 'bt-comm-directory', 'aria-label': t('Connected contacts') },
    h('div', { className: 'bt-comm-directory-heading' }, h('h3', null, t('Connected contacts')), h('span', { className: 'bt-comm-count' }, people.length)),
    h('label', { className: 'bt-comm-field' }, t('Find a contact or Bot'), h('input', { type: 'search', value: query, 'aria-label': t('Find a contact or Bot'), onChange: event => setQuery(event.target.value) })),
    shown.map(({ person, available, bots, relation }) => h('article', { key: person.principalId, className: 'bt-comm-contact-card', 'data-contact-id': person.principalId },
      h('div', { className: 'bt-comm-contact-card-head' }, identity(person, available), available ? message(person) : null),
      person.homeInstanceId ? h('p', { className: 'bt-comm-reference' }, person.instanceLabel ?? person.homeInstanceId, ' · ', t(person.ipAddress || 'Address unavailable')) : null,
      addressNotes[normalizeIpAddress(person.ipAddress)] ? h('p', { className: 'bt-comm-ip-note' }, t('IP note'), ': ', addressNotes[normalizeIpAddress(person.ipAddress)]) : null,
      !available ? h('p', { className: 'bt-comm-reference', role: 'status' }, t('Contact details are not available in the current directory.')) : null,
      h('h4', null, t('Their Bots')),
      bots.length ? h('ul', { className: 'bt-comm-contact-bots' }, bots.map(botRow)) : h('p', { className: 'bt-comm-reference' }, t('No Bots shared with you')),
      h('details', { className: 'bt-comm-contact-info' }, h('summary', null, t('Contact details')),
        h('dl', null, h('dt', null, t('Human identity')), h('dd', null, h('code', null, person.principalId)),
          person.homeInstanceId ? h(Fragment, null, h('dt', null, t('Device identity')), h('dd', null, h('code', null, person.homeInstanceId))) : null,
          relation ? h(Fragment, null, h('dt', null, t('Bots you share with this contact')), h('dd', null, (relation.botPrincipalIds ?? []).map(id => labels.get(id) ?? id).join(', ') || t('None'))) : null),
        bots.length ? h('ul', { className: 'bt-comm-bot-identities' }, bots.map(bot => h('li', { key: bot.principalId }, labels.get(bot.principalId) ?? bot.displayName, ': ', h('code', null, bot.principalId)))) : null,
        relation ? h('button', { type: 'button', className: 'bt-comm-danger', disabled: busy, onClick: () => onRemove(relation) }, t(confirm === person.principalId ? 'Confirm contact removal' : 'Remove contact')) : null))),
    bots.length ? h('section', { className: 'bt-comm-contact-card' }, h('h3', null, t('Other available Bots')), h('ul', { className: 'bt-comm-contact-bots' }, bots.map(botRow))) : null,
    !shown.length && !bots.length ? h('p', { className: 'bt-comm-reference', role: 'status' }, t(needle ? 'No matching contacts or Bots.' : 'No contacts yet. Add someone with their user code.')) : null)
}
