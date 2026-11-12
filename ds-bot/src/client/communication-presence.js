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
export function presenceState(person,context) {
  if(context&&!context.known)return 'unknown'
  const value=context?.people.get(person.principalId)??person
  if(person.retired||value.retired||value.connected===false)return 'offline'
  if(value.connected!==true||value.working===null)return 'unknown'
  return value.working===true?'working':'online'
}
export function BotPresenceBadge({person}) {
  const status=presenceState(person,useContext(Presence))
  const label=t(status==='working'?'Bot working or replying':status==='online'?'Bot online':status==='offline'?'Bot offline':'Bot status unknown')
  return h('span',{className:'bt-comm-presence','data-bot-status':status,role:'img','aria-label':label,title:label})
}
