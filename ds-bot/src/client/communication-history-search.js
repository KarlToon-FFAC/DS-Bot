import {createElement as h,useEffect,useRef,useState} from 'react'
import {communicationFailure} from './communication-errors.js'
import {t} from './i18n.js'

export function CommunicationHistorySearch({request,conversations,initialConversationId='',onSelect}){
 const [query,setQuery]=useState(''),[selection,setSelection]=useState(initialConversationId),[page,setPage]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const order=useRef(0),live=useRef(true),[trail,setTrail]=useState([])
 const scope=JSON.stringify(conversations.map(item=>[item.conversationId,item.membershipEpoch]).sort()),key=JSON.stringify([query.trim(),selection,scope]),current=useRef(key);current.current=key
 useEffect(()=>{live.current=true;return()=>{live.current=false;order.current++}},[])
 const search=async(cursor=null)=>{
  const token=++order.current,context=key
  setBusy(true);setError('')
  try{
   const selected=conversations.find(item=>item.conversationId===selection)
   const value=await request({endpoint:'search-history',query:query.trim(),limit:20,...(selection?{conversationId:selection,membershipEpoch:selected?.membershipEpoch}:{}),...(cursor?{cursor}:{})})
   if(!live.current||current.current!==context||order.current!==token)return false
   setPage({...value,context,cursor});return true
  }catch(failure){if(live.current&&current.current===context&&order.current===token)setError(communicationFailure(failure));return false}
  finally{if(live.current&&current.current===context&&order.current===token)setBusy(false)}
 }
 useEffect(()=>{
  order.current++;setPage(null);setTrail([]);setError('');setBusy(false)
  if(!query.trim())return
  const timer=setTimeout(()=>{void search()},250)
  return()=>{clearTimeout(timer);order.current++}
 },[key,request])
 const result=page?.context===key?page:null
 const highlight=text=>{
  const needle=query.trim().toLowerCase(),index=text.toLowerCase().indexOf(needle)
  return index<0?text:h('span',null,text.slice(0,index),h('mark',null,text.slice(index,index+needle.length)),text.slice(index+needle.length))
 }
 return h('div',{className:'bt-comm-history-search'},
  h('label',{className:'bt-comm-field'},t('Search chat history'),h('input',{value:query,maxLength:200,'aria-label':t('Search chat history'),onChange:event=>setQuery(event.target.value)})),
  h('label',{className:'bt-comm-field'},t('Search scope'),h('select',{value:selection,'aria-label':t('Search scope'),onChange:event=>setSelection(event.target.value)},
   h('option',{value:''},t('All conversations')),conversations.map(item=>h('option',{key:item.conversationId,value:item.conversationId},item.searchTitle)))),
  h('p',{className:'bt-comm-reference'},t('Searches messages already synchronized to this device, including archived private chats.')),
  busy?h('p',{role:'status'},t('Searching chat history…')):null,
  error?h('div',{role:'alert',className:'bt-comm-error'},t(error),h('button',{type:'button',disabled:busy,onClick:()=>{setTrail([]);void search()}},t('Search again'))):null,
  h('div',{className:'bt-comm-history-results','aria-label':t('Chat history results')},(result?.results??[]).map(item=>h('button',{type:'button',key:JSON.stringify([item.conversationId,item.membershipEpoch,item.messageId]),className:'bt-comm-history-result',disabled:busy,onClick:()=>onSelect(item)},
   h('span',{className:'bt-comm-history-result-meta'},h('strong',null,conversations.find(row=>row.conversationId===item.conversationId)?.searchTitle??t('Conversation')),
    h('span',null,[...(conversations.find(row=>row.conversationId===item.conversationId)?.info?.members??[]),...(conversations.find(row=>row.conversationId===item.conversationId)?.info?.formerMembers??[])].find(person=>person.principalId===item.author.principalId)?.displayName??item.author.displayName??t('Participant')),item.serverAcceptedAt?h('time',{dateTime:item.serverAcceptedAt},new Date(item.serverAcceptedAt).toLocaleString()):null),
   h('span',{className:'bt-comm-history-excerpt'},highlight(item.excerpt))))),
  result&&!busy&&!result.results.length?h('p',{role:'status'},t('No matching messages.')):null,
  h('div',{className:'bt-comm-history-pages'},trail.length?h('button',{type:'button',disabled:busy,onClick:()=>{void search(trail.at(-1)).then(ok=>{if(ok)setTrail(current=>current.slice(0,-1))})}},t('Previous results')):null,
   result?.hasMore?h('button',{type:'button',disabled:busy,onClick:()=>{void search(result.nextCursor).then(ok=>{if(ok)setTrail(current=>[...current,result.cursor])})}},t('Next results')):null))
}
