import {createHash} from 'node:crypto'
import {avatarBytes} from '../avatar.js'
const fail=code=>{throw Object.assign(new Error(code),{code})}
export function requireGroupProfiles(runtime){
  if(!runtime.transport.welcome?.capabilities?.includes('group-profiles'))fail('GROUP_PROFILES_CAPABILITY_REQUIRED')
}
export async function readGroupAvatar(runtime,input){
  requireGroupProfiles(runtime)
  const principalId=runtime.human.principalId
  const member=runtime.member(principalId,input.conversationId,input.membershipEpoch)
  const value=await runtime.transport.request('group.avatar.read',{principalId,conversationId:input.conversationId,membershipEpoch:member.membershipEpoch,revision:input.revision})
  if(value.conversationId!==input.conversationId||value.revision!==input.revision||typeof value.image!=='string'||value.image.length>32768
    ||createHash('sha256').update(value.image).digest('hex')!==input.revision)fail('INVALID_AVATAR_RESPONSE')
  try{avatarBytes(value.image)}catch{fail('INVALID_AVATAR_RESPONSE')}
  return value
}
export async function setGroupProfile(runtime,input){
  requireGroupProfiles(runtime)
  const common={conversationId:input.conversationId,membershipEpoch:input.membershipEpoch,expectedVersion:input.expectedVersion}
  if(input.endpoint==='set-group-avatar'){
    if(input.image!==null){
      if(typeof input.image!=='string'||input.image.length>32768)fail('INVALID_AVATAR')
      try{avatarBytes(input.image)}catch{fail('INVALID_AVATAR')}
    }
    return runtime.operation(runtime.human.principalId,'group.avatar.set',{...common,image:input.image},input.operationId)
  }
  return runtime.operation(runtime.human.principalId,'group.identity.set',{...common,targetPrincipalId:input.targetPrincipalId,identity:input.identity},input.operationId)
}

export async function readGroupIdentity(runtime,input){
  requireGroupProfiles(runtime)
  const principalId=runtime.human.principalId,member=runtime.member(principalId,input.conversationId,input.membershipEpoch)
  const value=await runtime.transport.request('group.identity.read',{principalId,conversationId:input.conversationId,membershipEpoch:member.membershipEpoch,targetPrincipalId:input.targetPrincipalId})
  if(value.conversationId!==input.conversationId||value.principalId!==input.targetPrincipalId||typeof value.identity!=='string'||[...value.identity].length>4000)fail('INVALID_GROUP_IDENTITY')
  return value
}
