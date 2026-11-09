import {createElement as h,useEffect,useRef,useState} from 'react'
import {readCommunicationBrowserState,saveCommunicationBrowserState} from './communication-reset.js'
import {t} from './i18n.js'

const key='ds-bot:communication:column-widths'
const defaults={left:280,right:400},minimum={left:240,right:320},maximum={left:480,right:800}
const clamp=(side,value,max=maximum[side])=>Math.max(Math.min(minimum[side],max),Math.min(max,Number.isFinite(value)?value:defaults[side]))
export function useCommunicationWidths(){
 const [widths,setWidths]=useState(()=>{try{const value=JSON.parse(readCommunicationBrowserState(localStorage,key));return {left:clamp('left',value?.left),right:clamp('right',value?.right)}}catch{return defaults}})
 const change=(side,value)=>setWidths(current=>{const next={...current,[side]:clamp(side,value)};try{saveCommunicationBrowserState(localStorage,key,next)}catch{/* Keep the live width if browser storage is unavailable. */}return next})
 return [widths,change]
}
export function CommunicationResizeHandle({side,width,onChange}){
 const cleanup=useRef(null)
 useEffect(()=>()=>cleanup.current?.(),[])
 const limits=node=>Math.min(maximum[side],Math.max(minimum[side],side==='left'?window.innerWidth-420:(node.closest('.bt-comm-main')?.clientWidth??window.innerWidth)-(window.innerWidth>=1280?420:0)))
 return h('div',{className:`bt-comm-resize bt-comm-resize-${side}`,role:'separator',tabIndex:0,'aria-orientation':'vertical',
  'aria-label':t(side==='left'?'Resize conversation sidebar':'Resize group information sidebar'),'aria-valuemin':minimum[side],'aria-valuemax':maximum[side],'aria-valuenow':Math.round(width),
  onKeyDown:event=>{
   if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
   event.preventDefault();const max=limits(event.currentTarget)
   const next=event.key==='Home'?minimum[side]:event.key==='End'?max:width+(event.key==='ArrowRight'?1:-1)*(side==='left'?1:-1)*16
   onChange(side,clamp(side,next,max))
  },onPointerDown:event=>{
   if(event.button!==0)return
   event.preventDefault();cleanup.current?.()
   const node=event.currentTarget,start=event.clientX,initial=node.parentElement.getBoundingClientRect().width,pointer=event.pointerId,max=limits(node)
   const before={cursor:document.body.style.cursor,userSelect:document.body.style.userSelect}
   document.body.style.cursor='col-resize';document.body.style.userSelect='none'
   const move=next=>{if(next.pointerId===pointer)onChange(side,clamp(side,initial+(next.clientX-start)*(side==='left'?1:-1),max))}
   const finish=next=>{if(next&&next.pointerId!==pointer)return;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);window.removeEventListener('blur',blur);Object.assign(document.body.style,before);cleanup.current=null}
   const blur=()=>finish()
   cleanup.current=()=>finish();window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish);window.addEventListener('blur',blur)
  }})
}
