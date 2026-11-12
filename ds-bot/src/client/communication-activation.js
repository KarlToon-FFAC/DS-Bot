import {createElement as h} from 'react'
import {CompactBotList} from './communication-bot-list.js'
import {contactLabels} from './communication-model.js'
import {t} from './i18n.js'

// Only the canonical Hub dispatch record can establish actual recipients.
// Text mentions and composer previews describe intent, not delivery outcome.
export function CommunicationActivation({event,members,request,pending=false}) {
  const ids=Array.isArray(event?.activatedBotPrincipalIds)?[...new Set(event.activatedBotPrincipalIds)]:null
  if(ids?.length===0)return null
  const labels=contactLabels(members)
  return h('div',{className:'bt-comm-activation','data-activation-known':ids!==null,'aria-label':t('Bot dispatch'),
    title:t('Bots selected by the Hub for this message. This does not mean they have started or finished processing.')},
    ids===null?h('span',null,t(pending?'Awaiting dispatch confirmation':'Dispatch not recorded'))
      :h(CompactBotList,{attribute:'data-activated-bot',request,people:ids.map(id=>{
        const person=members.find(member=>member.principalId===id)
        return {...(person??{principalId:id,kind:'bot'}),displayName:labels.get(id)??id,avatarAllowed:Boolean(person)}
      })}))
}
