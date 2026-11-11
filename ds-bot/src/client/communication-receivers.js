import {createElement as h,useEffect,useState} from 'react'
import {CommunicationActionDialog} from './communication-dialog.js'
import {CommunicationAvatar} from './communication-profile.js'
import {groupMemberContacts} from './communication-group.js'
import {contactLabels} from './communication-model.js'
import {t} from './i18n.js'

export function ReceivingBotsDialog({open,onClose,members,contacts,selected,onConfirm,request,multipleAvailable}) {
  const [ids,setIds] = useState([])
  useEffect(() => { if (open) setIds([...selected]) },[open])
  const bots = members.filter(person => person.kind === 'bot' && !person.retired && person.published !== false && ['passive','active'].includes(person.speakingMode))
  const eligible = new Set(bots.map(person => person.principalId)), labels = contactLabels(members)
  const unavailable = ids.filter(id => !eligible.has(id))
  const unsupported = ids.length > 1 && !multipleAvailable
  const choose = (id,checked) => setIds(current => checked ? [...new Set([...current,id])] : current.filter(value => value !== id))
  return h(CommunicationActionDialog,{open,title:'Default receiving Bots',onClose,confirmLabel:'Use selected Bots',
    disabled:!ids.length || unavailable.length > 0 || unsupported,
    onConfirm:() => onConfirm([...ids].sort())},
    h('p',{className:'bt-comm-reference'},t('Unmentioned user messages go to every selected Bot. Mentions and direct replies keep their targets. Bot answers do not wake the default list.')),
    h('div',{className:'bt-comm-group-choices'},groupMemberContacts(members,contacts).map((group,index) => {
      const choices = group.bots.filter(bot => eligible.has(bot.principalId))
      if (!choices.length) return null
      return h('section',{key:group.person?.principalId ?? index,className:'bt-comm-group-contact'},
        h('div',{className:'bt-comm-group-contact-heading'},h('strong',null,group.person?.displayName ?? t('Owner information unavailable'))),
        choices.map(bot => h('label',{key:bot.principalId,className:'bt-comm-check'},
          h('input',{type:'checkbox','data-receiving-bot':bot.principalId,'aria-label':t('Receive plain messages as {name}',{name:labels.get(bot.principalId) ?? bot.displayName}),checked:ids.includes(bot.principalId),onChange:event => choose(bot.principalId,event.target.checked)}),
          h(CommunicationAvatar,{person:bot,request,size:24}),h('span',{className:'bt-comm-choice-name'},labels.get(bot.principalId) ?? bot.displayName))))
    })),
    !bots.length ? h('p',{role:'status'},t('No available group Bots. Add a published Bot first.')) : null,
    unavailable.map(id => h('label',{key:id,className:'bt-comm-check'},h('input',{type:'checkbox',checked:true,onChange:() => choose(id,false)}),t('Unavailable Bot'),': ',labels.get(id) ?? id)),
    unsupported ? h('p',{role:'status'},t('This Hub does not support multiple default receiving Bots. Update the Hub to select more than one Bot.')) : null)
}
