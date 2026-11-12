import {useEffect,useLayoutEffect,useRef,useState} from 'react'

export const HISTORY_PAGE_SIZE=50,HISTORY_WINDOW_SIZE=200
const combine=(left,right)=>[...new Map([...left,...right].map(event=>[event.conversationSeq,event])).values()].sort((a,b)=>a.conversationSeq-b.conversationSeq)
export function useCommunicationHistory({scope,member,visible,request,log,autoScroll,onError,onLoaded}){
 const key=JSON.stringify([scope,member?.conversationId,member?.membershipEpoch]),current=useRef(key),generation=useRef(0),flight=useRef(null),restore=useRef(null),retry=useRef(null)
 const [stored,setStored]=useState(null),[loading,setLoading]=useState(false),[failure,setFailure]=useState(false)
 const latest=useRef({member,onError,onLoaded});latest.current={member,onError,onLoaded}
 if(current.current!==key){current.current=key;generation.current++;flight.current=null;restore.current=null}
 const page=stored?.context===key?stored:null,cache=useRef(page);cache.current=page
 const watermark=member?.cachedWatermark??member?.watermark
 const normalize=value=>({...value,context:key,scope,events:value.events??[],watermark:value.watermark??watermark??0,
  hasEarlier:value.hasEarlier??Boolean(value.events?.length&&value.events[0].conversationSeq>(member?.joinSeq??1)),
  hasLater:value.hasLater??Boolean(value.events?.length&&value.events.at(-1).conversationSeq<value.watermark)})
 const capture=()=>{
  const element=log.current,boundary=element?.getBoundingClientRect().top
  const node=[...(element?.querySelectorAll('article[data-message-id]')??[])].find(item=>item.getBoundingClientRect().bottom>boundary)
  return node?{key,id:node.dataset.messageId,top:node.getBoundingClientRect().top}:null
 }
 const fetchPage=async(mode,values={},force=false)=>{
  const previous=cache.current
  if(!visible||!member||flight.current&&mode!=='latest'&&mode!=='jump')return
  if(mode==='earlier'&&(!previous?.hasEarlier||!previous.events.length)||mode==='later'&&(!previous||!previous.events.length||!previous.hasLater&&!force))return
  const order=++generation.current,context=key
  flight.current=order;retry.current=()=>fetchPage(mode,values,force);setLoading(true);setFailure(false)
  if(mode==='earlier'||mode==='jump')autoScroll.current=false
  try{
   const value=normalize(await request({endpoint:'history',conversationId:member.conversationId,membershipEpoch:member.membershipEpoch,limit:HISTORY_PAGE_SIZE,latest:mode!=='later',
    ...(mode==='earlier'?{before:previous.events[0].conversationSeq-1}:mode==='later'?{after:previous.events.at(-1).conversationSeq}:{}),...values}))
   if(current.current!==context||generation.current!==order||value.conversationId!==member.conversationId||value.membershipEpoch!==member.membershipEpoch)return
   const existing=cache.current
   if(['earlier','later'].includes(mode)&&existing){
    const merged=combine(value.events,existing.events),trimmed=merged.length>HISTORY_WINDOW_SIZE
    if(!autoScroll.current||mode==='later'&&existing.hasLater){restore.current=capture();autoScroll.current=false}
    if(mode==='earlier'){
     const progressed=value.events.some(event=>event.conversationSeq<existing.events[0].conversationSeq)
     setStored({...value,events:merged.slice(0,HISTORY_WINDOW_SIZE),hasEarlier:progressed&&value.hasEarlier,hasLater:existing.hasLater||trimmed,watermark:Math.max(value.watermark??0,existing.watermark??0)})
    }else setStored({...value,events:merged.slice(-HISTORY_WINDOW_SIZE),hasEarlier:existing.hasEarlier||trimmed})
   }else{restore.current=null;setStored({...value,events:value.events.slice(-HISTORY_PAGE_SIZE)})}
   latest.current.onLoaded?.()
  }catch(error){if(current.current===context&&generation.current===order){setFailure(true);if(['FORBIDDEN','NOT_A_MEMBER','MEMBERSHIP_REVOKED'].includes(error.code))setStored(null);latest.current.onError?.(error)}}
  finally{if(current.current===context&&flight.current===order){flight.current=null;setLoading(false)}}
 }
 const methods=useRef(null)
 methods.current={earlier:()=>fetchPage('earlier'),later:()=>fetchPage('later'),latest:()=>{autoScroll.current=true;return fetchPage('latest')},jump:seq=>fetchPage('jump',{before:seq+Math.floor(HISTORY_PAGE_SIZE/2)})}
 useEffect(()=>{
  generation.current++;flight.current=null;if(visible||!member)setStored(null);setLoading(false);setFailure(false)
  if(visible&&member)void methods.current.latest()
  return()=>{generation.current++;flight.current=null}
 },[key,visible,request])
 useEffect(()=>{
  if(!visible||!page||failure||!Number.isSafeInteger(watermark)||watermark<=Math.max(page.watermark??0,page.events.at(-1)?.conversationSeq??0))return
  if(flight.current)return
  // Empty histories have no message cursor for a later-page request.
  if(!page.events.length){void methods.current.latest();return}
  if(autoScroll.current&&!page.hasLater){
   // A long offline catch-up should still mount only the latest page.
   if(watermark-(page.events.at(-1)?.conversationSeq??0)>HISTORY_WINDOW_SIZE)void methods.current.latest()
   else void fetchPage('later',{},true)
  }else setStored(previous=>previous?.context===key?{...previous,hasLater:true,watermark}:previous)
 },[key,visible,watermark,page?.watermark,loading,failure])
 useLayoutEffect(()=>{
  const anchor=restore.current;restore.current=null
  if(anchor?.key!==key)return
  const node=[...(log.current?.querySelectorAll('article[data-message-id]')??[])].find(item=>item.dataset.messageId===anchor.id)
  if(node)log.current.scrollTop+=node.getBoundingClientRect().top-anchor.top
 },[stored,key])
 useEffect(()=>{
  const element=log.current
  if(visible&&page?.hasEarlier&&!loading&&!failure&&element?.clientHeight>0&&element.scrollHeight<=element.clientHeight+2)void methods.current.earlier()
 },[visible,stored,loading,failure])
 return {page,loading,failure,clear:()=>{generation.current++;flight.current=null;setStored(null);setLoading(false)},retry:()=>retry.current?.(),loadEarlier:()=>methods.current.earlier(),loadLater:()=>methods.current.later(),showLatest:()=>methods.current.latest(),jumpTo:seq=>methods.current.jump(seq)}
}
