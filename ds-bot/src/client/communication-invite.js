import {createElement as h,useEffect,useRef,useState} from 'react'
import {CommunicationActionDialog} from './communication-dialog.js'
import {GroupBotChoices} from './communication-group.js'
import {communicationFailure,operationOutcomeUncertain} from './communication-errors.js'
import {t} from './i18n.js'

export function GroupInviteDialog({open,onClose,member,contacts,humanId,request,operation,pendingInvites,busy=false}){
 const [selected,setSelected]=useState([]),[results,setResults]=useState({}),[working,setWorking]=useState(false),[notice,setNotice]=useState('')
 const live=useRef(true),flight=useRef(false),pending=useRef(new Map()),names=useRef(new Map()),latest=useRef(null)
 latest.current={member,contacts,pendingInvites}
 useEffect(()=>{live.current=true;return()=>{live.current=false}},[])
 useEffect(()=>{
  if(!open)return
  names.current=new Map([...(latest.current.member.info?.members??[]),...latest.current.contacts].map(person=>[person.principalId,person.displayName]))
  pending.current=new Map((latest.current.pendingInvites?.()??[]).map(intent=>[intent.inviteePrincipalId,intent]))
  setSelected([...pending.current.keys()]);setResults(Object.fromEntries([...pending.current.keys()].map(id=>[id,{status:'Not confirmed'}])));setNotice(pending.current.size?'An invitation is not confirmed. Retry to check the same request before continuing.':'')
 },[open])
 const label=id=>latest.current.contacts.find(person=>person.principalId===id)?.displayName??latest.current.member.info?.members?.find(person=>person.principalId===id)?.displayName??names.current.get(id)??id
 const submit=async()=>{
  if(flight.current)return false
  flight.current=true;setWorking(true);setNotice('')
  const targets=[...new Set([...pending.current.keys(),...selected])]
  let complete=true
  try{
   for(const id of targets){
    if(!live.current)return false
    let intent=pending.current.get(id)
    try{
     if(!intent){
      const canonical=await request({endpoint:'members',conversationId:member.conversationId,membershipEpoch:member.membershipEpoch})
      if(!live.current)return false
      if(!Array.isArray(canonical.members)||!Number.isSafeInteger(canonical.membershipVersion))throw Object.assign(Error('COMMUNICATION_UNAVAILABLE'),{code:'COMMUNICATION_UNAVAILABLE'})
      if(canonical.members.some(person=>person.principalId===id)){
       setSelected(current=>current.filter(value=>value!==id));setResults(current=>({...current,[id]:{status:'Already in group'}}));continue
      }
      intent={conversationId:member.conversationId,membershipEpoch:member.membershipEpoch,expectedVersion:canonical.membershipVersion,inviteePrincipalId:id}
     }
     pending.current.set(id,intent)
     const value=await operation('invite',intent)
     if(!live.current)return false
     if(value.status==='queued'){
      setResults(current=>({...current,[id]:{status:'Not confirmed'}}));setNotice('An invitation is not confirmed. Retry to check the same request before continuing.');return false
     }
     pending.current.delete(id);setSelected(current=>current.filter(value=>value!==id));setResults(current=>({...current,[id]:{status:'Joined'}}))
    }catch(failure){
     if(!live.current)return false
     complete=false
     const uncertain=intent&&operationOutcomeUncertain(failure)
     if(!uncertain)pending.current.delete(id)
     setResults(current=>({...current,[id]:{status:uncertain?'Not confirmed':'Could not join',error:communicationFailure(failure)}}))
     if(uncertain){setNotice('An invitation is not confirmed. Retry to check the same request before continuing.');return false}
     if(!intent||['FORBIDDEN','NOT_A_MEMBER','MEMBERSHIP_REVOKED','GROUP_VERSION_CONFLICT','MEMBER_LIMIT'].includes(failure.code))break
    }
   }
   if(!complete)setNotice('Some Bots could not join. Review the results and retry the remaining selection.')
   return complete
  }finally{flight.current=false;if(live.current)setWorking(false)}
 }
 const members=member.info?.members??[],locked=[...pending.current.keys()]
 return h(CommunicationActionDialog,{open,title:'Invite participant',onClose,confirmLabel:'Invite',disabled:busy||working||!selected.length&&!locked.length,onConfirm:submit},
  h('p',null,member.title),h('p',{className:'bt-comm-reference'},t('Select multiple Bots. Their contacts join automatically.')),
  h(GroupBotChoices,{contacts:contacts.filter(person=>person.kind==='human'||!person.retired&&person.published!==false&&!members.some(item=>item.principalId===person.principalId)),humanId,instanceId:contacts.find(person=>person.principalId===humanId)?.homeInstanceId,selected,onChange:setSelected,request,disabled:working||busy,disabledIds:locked}),
  h('p',{className:'bt-comm-reference'},t('Selected Bots: {count}',{count:selected.length})),
  notice?h('p',{role:'status'},t(notice)):null,
  Object.keys(results).length?h('section',{'aria-label':t('Invitation results')},h('h3',null,t('Invitation results')),h('ul',{className:'bt-comm-invite-results'},Object.entries(results).map(([id,result])=>h('li',{key:id},h('strong',null,label(id)),' · ',t(result.status),result.error?h('p',{className:'bt-comm-error'},result.error):null)))):null)
}
