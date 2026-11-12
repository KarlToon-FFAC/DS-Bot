import {createElement as h} from 'react'
import {humanReceivingBots} from '../../../communication-hub/src/human-routing.js'
import {communicationMentions} from '../shared/communication-mentions.js'
import {CompactBotList} from './communication-bot-list.js'
import {contactLabels} from './communication-model.js'
import {t} from './i18n.js'

export function previewRecipients(member, draft, target, directedReplies, replyMentionUnion = false) {
  const info = member?.info
  if (!info?.members || info.membershipVersion !== member.membershipVersion) return {unavailable:true,bots:[]}
  const members = info.members
  try {
    const mentions = communicationMentions(draft.text ?? '',members,draft.mentions ?? [],{retired:info.formerMembers ?? []})
    const replyToMessageId = draft.replyToMessageId ?? target?.messageId
    if (replyToMessageId && !target?.author) return {unavailable:true,bots:[]}
    const replyAuthorId = members.some(person=>person.principalId===target?.author?.principalId && person.kind==='bot') ? target.author.principalId : undefined
    const defaultBotIds = info.routingMode === 'admin' ? info.defaultBotPrincipalIds ?? (info.adminBotPrincipalId ? [info.adminBotPrincipalId] : []) : []
    return {bots:humanReceivingBots({kind:member.kind,members,mentions,replyToMessageId,replyAuthorId,defaultBotIds,directedReplies,replyMentionUnion})}
  } catch (error) { return {error:error.code,bots:[]} }
}

export function RecipientPreview({member,draft,target,request,directedReplies,replyMentionUnion}) {
  const preview = previewRecipients(member,draft,target,directedReplies,replyMentionUnion)
  const labels = contactLabels(member?.info?.members ?? [])
  return h('div',{className:'bt-comm-recipient-preview',role:'status','aria-live':'polite',
    title:t('These Bots will be asked to process this message. Other members can still read the group history. Bots may choose not to reply.')},
    h('span',{className:'bt-comm-recipient-heading'},t('Bot recipients'),':'),
    preview.unavailable ? h('span',null,t('Waiting for current members…'))
      : preview.error ? h('span',null,t('Check mentions before sending.'))
      : !preview.bots.length ? h('span',null,t('No Bot will be activated'))
      : h(CompactBotList,{people:preview.bots.map(person=>({...person,displayName:labels.get(person.principalId)??person.displayName})),request}))
}
