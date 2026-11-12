import {BotAvailabilityNotice} from './communication-presence.js'
import {createElement as h,useEffect,useLayoutEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {CommunicationAvatar} from './communication-profile.js'
import {t} from './i18n.js'

export function CompactBotList({people,request,attribute='data-recipient-id'}) {
  const [open,setOpen]=useState(false),[pinned,setPinned]=useState(false),[position,setPosition]=useState(null)
  const trigger=useRef(null),popup=useRef(null),timer=useRef(null)
  const close=()=>{setOpen(false);setPinned(false)}
  const leave=()=>{clearTimeout(timer.current);if(!pinned)timer.current=setTimeout(()=>setOpen(false),160)}
  const enter=()=>{clearTimeout(timer.current);setOpen(true)}
  useEffect(()=>()=>clearTimeout(timer.current),[])
  useEffect(()=>{close()},[people.map(person=>person.principalId).join('\n')])
  useLayoutEffect(()=>{
    if(!open)return undefined
    const place=()=>{
      const anchor=trigger.current?.getBoundingClientRect();if(!anchor)return
      const width=Math.min(340,window.innerWidth-24),below=window.innerHeight-anchor.bottom-18,above=anchor.top-18
      const downward=below>=Math.min(320,above)
      setPosition({width,maxHeight:Math.max(60,Math.min(320,downward?below:above)),left:Math.max(12,Math.min(anchor.left,window.innerWidth-width-12)),
        top:downward?anchor.bottom+6:anchor.top-6,transform:downward?'none':'translateY(-100%)'})
    }
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true)
    const outside=event=>{if(!trigger.current?.contains(event.target)&&!popup.current?.contains(event.target))close()}
    const keys=event=>{if(event.key==='Escape'){event.stopImmediatePropagation();event.preventDefault();close();trigger.current?.focus()}}
    document.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',keys,true)
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);document.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',keys,true)}
  },[open])
  const avatar=(person,size)=>h(CommunicationAvatar,{person,request,allowed:person.avatarAllowed!==false,size})
  return h('span',{className:'bt-comm-bot-list'},people.slice(0,2).map(person=>h('span',{key:person.principalId,className:'bt-comm-bot-chip',[attribute]:person.principalId,
    title:`${person.displayName}${person.receivingReason?' · '+t(person.receivingReason):''}`},avatar(person,18),h('span',null,person.displayName,h(BotAvailabilityNotice,{person})))),
    people.length>2?h('button',{ref:trigger,type:'button',className:'bt-comm-bot-more','aria-label':t('View all {count} Bots',{count:people.length}),'aria-expanded':open,'aria-haspopup':'dialog',
      onMouseEnter:enter,onMouseLeave:leave,onClick:()=>{clearTimeout(timer.current);if(pinned)close();else{setPinned(true);setOpen(true)}}},t('{count} Bots in total',{count:people.length})):null,
    open&&position&&people.length>2?createPortal(h('section',{ref:popup,className:'bt-comm-bot-popover',role:'dialog','aria-label':t('All Bot recipients'),style:position,onMouseEnter:()=>clearTimeout(timer.current),onMouseLeave:leave},
      h('header',null,h('strong',null,t('{count} Bots in total',{count:people.length})),h('button',{type:'button','aria-label':t('Close Bot list'),onClick:close},'×')),
      h('ul',null,people.map(person=>h('li',{key:person.principalId,[attribute]:person.principalId},avatar(person,24),h('span',null,person.displayName,h(BotAvailabilityNotice,{person}),person.receivingReason?h('small',null,t(person.receivingReason)):null))))),trigger.current?.closest('dialog')??trigger.current?.closest('.bt-comm-frame')??document.body):null)
}
