import {createElement as h} from 'react'
import {CommunicationAvatar} from './communication-profile.js'
import {t} from './i18n.js'

export function MentionPerson({person,members,request}) {
  const owner=person.kind==='bot' ? members.find(member=>member.kind==='human' && member.principalId===person.ownerPrincipalId) : null
  return h('span',{className:'bt-comm-mention-person'},
    h(CommunicationAvatar,{person,request,size:24}),
    h('span',{className:'bt-comm-mention-name'},person.all?t('All Bots'):person.displayName??person.principalId),
    person.kind==='bot'?h('span',{className:'bt-comm-mention-owner'},' - ',owner?.displayName??t('Owner information unavailable')):null)
}
