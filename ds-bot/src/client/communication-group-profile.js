import {createElement as h,useEffect,useRef,useState} from 'react'
import {CommunicationDialog} from './communication-dialog.js'
import {ConversationAvatar} from './communication-list.js'
import {avatarImage} from './avatar-library.js'
import {communicationFailure,operationOutcomeUncertain} from './communication-errors.js'
import {t} from './i18n.js'

export function GroupProfileDialog({member,person,kind,operation,request,onClose,convertImage=avatarImage}){
  const [image,setImage]=useState(undefined),[identity,setIdentity]=useState(person?.groupIdentity??'')
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState(null)
  const fileOrder=useRef(0),version=useRef(member.membershipVersion)
  const avatar=kind==='avatar'
  const [loaded,setLoaded]=useState(!person?.groupIdentityTruncated)
  useEffect(()=>{
    if(avatar||!person?.groupIdentityTruncated)return undefined
    let active=true
    void request({endpoint:'group-identity',conversationId:member.conversationId,membershipEpoch:member.membershipEpoch,targetPrincipalId:person.principalId}).then(value=>{
      if(active){setIdentity(value.identity);setLoaded(true)}
    }).catch(failure=>{if(active)setError(communicationFailure(failure))})
    return()=>{active=false}
  },[avatar,member.conversationId,member.membershipEpoch,person?.principalId,person?.groupIdentityTruncated,request])
  const upload=async file=>{
    if(!file)return
    const token=++fileOrder.current;setBusy(true);setError('')
    try{const value=await convertImage(file,{maxLength:32768});if(token===fileOrder.current)setImage(value)}
    catch(failure){if(token===fileOrder.current)setError(failure.message)}
    finally{if(token===fileOrder.current)setBusy(false)}
  }
  const save=async()=>{
    setBusy(true);setError('')
    const intent=pending??{conversationId:member.conversationId,membershipEpoch:member.membershipEpoch,expectedVersion:version.current,
      ...(avatar?{image}:{targetPrincipalId:person.principalId,identity})}
    try{
      const result=await operation(avatar?'set-group-avatar':'set-group-identity',intent)
      if(result.status==='queued'){setPending(intent);setError(t('An operation is not confirmed. Check status, then retry the same action.'));return}
      onClose(result)
    }catch(failure){setError(communicationFailure(failure));if(operationOutcomeUncertain(failure))setPending(intent)}
    finally{setBusy(false)}
  }
  return h(CommunicationDialog,{open:true,title:avatar?'Group avatar':'Group collaboration identity',onClose,busy,error,
    actions:h('button',{type:'button',onClick:()=>{void save()},disabled:busy||avatar&&image===undefined||!avatar&&!loaded},t('Save'))},
    h('p',null,member.title,person?' · '+person.displayName:''),
    avatar?h('div',null,image?h('img',{src:image,alt:t('Avatar preview'),width:80,height:80}):h(ConversationAvatar,{conversation:image===null?{...member,info:{...member.info,avatar:null}}:member,request,size:80}),
      h('label',{className:'bt-comm-field'},t('Upload avatar'),h('input',{type:'file',accept:'image/png,image/jpeg,image/webp,image/gif','aria-label':t('Upload avatar'),disabled:busy||Boolean(pending),onChange:event=>{void upload(event.target.files?.[0]);event.target.value=''}})),
      h('button',{type:'button',disabled:busy||Boolean(pending),onClick:()=>{fileOrder.current++;setImage(null)}},t('Reset avatar')))
      :h('div',null,h('p',{className:'bt-comm-reference'},t('This identity applies only in this group. It does not change the Bot profile or grant permissions.')),
        h('label',{className:'bt-comm-field'},t('Group identity description'),h('textarea',{'aria-label':t('Group identity description'),rows:10,maxLength:4000,value:identity,disabled:busy||!loaded||Boolean(pending),onChange:event=>setIdentity(event.target.value)}))))
}

export function GroupIdentityInformation({person,conversationId,membershipEpoch,request}){
  const [full,setFull]=useState(null),[failed,setFailed]=useState(false)
  useEffect(()=>{
    setFull(null);setFailed(false)
    if(!person.groupIdentityTruncated)return undefined
    let active=true
    void request({endpoint:'group-identity',conversationId,membershipEpoch,targetPrincipalId:person.principalId}).then(value=>{if(active)setFull(value.identity)}).catch(()=>{if(active)setFailed(true)})
    return()=>{active=false}
  },[person.principalId,person.groupIdentity,person.groupIdentityTruncated,conversationId,membershipEpoch,request])
  return person.groupIdentity||person.groupIdentityTruncated?h('div',null,h('h3',null,t('Group collaboration identity')),h('p',{className:'bt-comm-participant-summary'},full??person.groupIdentity),failed?h('p',{role:'status'},t('Profile details are unavailable.')):null):null
}
