import {modelAvailabilityLabels} from '../shared/communication-availability.js'
import {createContext,createElement as h,useContext,useEffect,useState} from 'react'
import {t} from './i18n.js'

const Presence=createContext(null)
export function CommunicationPresence({state,unavailable,children}) {
  const [checked,setChecked]=useState(Date.now),[now,setNow]=useState(Date.now)
  useEffect(()=>{setChecked(Date.now())},[state])
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer)},[])
  const people=new Map([...(state?.conversations??[]),...(state?.botConversations??[])].flatMap(item=>[...(item.info?.members??[]),...(item.info?.formerMembers??[])])
    .concat(state?.contacts??[]).map(person=>[person.principalId,person]))
  return h(Presence.Provider,{value:{people,known:state?.connected===true&&state?.presenceFresh!==false&&!unavailable&&now-checked<15000}},children)
}
// Member snapshots can lag behind the current authorized contact directory.
export function useCommunicationAvatarPerson(person, preferDirectory = true) {
  const current=useContext(Presence)?.people.get(person.principalId)
  if(!preferDirectory||!current||person.retired)return person
  return {...person,displayName:current.displayName??person.displayName,
    ...(Object.hasOwn(current,'avatar')?{avatar:current.avatar}:{})}
}
export function availabilityLabel(person,context){
  if(context&&!context.known)return null
  const value=context?.people.get(person.principalId)??person
  if(person.retired||value.retired||value.connected!==true)return null
  return modelAvailabilityLabels[value.availabilityError]??null
}
export function BotAvailabilityNotice({person}){
  const label=availabilityLabel(person,useContext(Presence))
  return label?h('small',{className:'bt-comm-reference','data-bot-unavailable':person.principalId},' · '+t(label)):null
}
export function presenceState(person,context) {
  if(context&&!context.known)return 'unknown'
  const value=context?.people.get(person.principalId)??person
  if(person.retired||value.retired||value.connected===false)return 'offline'
  if(availabilityLabel(person,context))return 'unavailable'
  if(value.connected!==true||value.working===null)return 'unknown'
  return value.working===true?'working':'online'
}
export function BotPresenceBadge({person}) {
  const context=useContext(Presence),status=presenceState(person,context)
  const label=t(availabilityLabel(person,context)??(status==='working'?'Bot working or replying':status==='online'?'Bot online':status==='offline'?'Bot offline':'Bot status unknown'))
  return h('span',{className:'bt-comm-presence','data-bot-status':status,role:'img','aria-label':label,title:label})
}
