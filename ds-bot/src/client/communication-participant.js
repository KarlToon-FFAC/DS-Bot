import {BotAvailabilityNotice} from './communication-presence.js'
import {GroupIdentityInformation} from './communication-group-profile.js'
import { createElement as h, useEffect, useState } from 'react'
import { CommunicationAvatar } from './communication-profile.js'
import { t } from './i18n.js'

export function ParticipantInformation({ person, people, request, conversationId, membershipEpoch, localBotId, roleLabel, personLabel }) {
  const [loaded, setLoaded] = useState(null), [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    setLoaded(null); setError(false)
    void request({ endpoint: 'participant-profile', conversationId, membershipEpoch, localBotId, targetPrincipalId: person.principalId }).then(value => {
      if (!active) return
      if (value.principalId !== person.principalId || !value.publicProfile || value.publicProfile.truncated) { setError(true); return }
      setLoaded(value.publicProfile)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [request, conversationId, membershipEpoch, localBotId, person.principalId])
  const contact = people.filter(item => item.principalId === person.principalId).reduce((known,item) => ({...known,...item}), {})
  const ownerId = person.ownerPrincipalId ?? contact?.ownerPrincipalId
  const ownerRows = ownerId ? people.filter(item => item.principalId === ownerId && item.kind === 'human') : []
  const owner = ownerRows.length ? ownerRows.reduce((known,item) => ({...known,...item}), {}) : null
  const profile = loaded ?? (person.publicProfile?.truncated ? contact?.publicProfile : person.publicProfile) ?? contact?.publicProfile
  return h('section', { className: 'bt-comm-participant-profile' }, personLabel(person), h(BotAvailabilityNotice,{person}), h('p', null, t(person.retired ? 'Bot no longer exists' : roleLabel(person.role ?? 'member'))),
    person.kind === 'bot' ? h('div', { className: 'bt-comm-participant-owner' }, h('h3', null, t('From contact')),
      owner ? h('p', null, h(CommunicationAvatar, { person: owner, request, size: 28 }), owner.displayName,
        owner.ipAddress ? h('small', null, owner.ipAddress) : null) : h('p', null, t('Owner information unavailable'))) : null,
    h(GroupIdentityInformation,{person,conversationId,membershipEpoch,request}),
    h('h3', null, t('Public profile')), profile?.headline ? h('strong', null, profile.headline) : null,
    profile?.summary ? h('p', { className: 'bt-comm-participant-summary' }, profile.summary) : null,
    profile?.expertise?.length ? h('ul', { className: 'bt-comm-directory-skills' }, profile.expertise.map(term => h('li', { key: term }, term))) : null,
    !profile?.headline && !profile?.summary && !profile?.expertise?.length ? h('p', { className: 'bt-comm-reference' }, t('No public profile shared.')) : null,
    error ? h('p', { role: 'status', className: 'bt-comm-reference' }, t('Profile details are unavailable.')) : null,
    h('details', null, h('summary', null, t('Identity details')), h('code', null, person.principalId), person.retiredAt ? h('p', null, t('Identity ended'), ': ', person.retiredAt) : null,
      person.instanceLabel || person.homeInstanceId ? h('p', null, person.instanceLabel ?? person.homeInstanceId) : null))
}
