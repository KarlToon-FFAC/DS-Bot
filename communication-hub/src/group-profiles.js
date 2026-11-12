import { avatarRevision, validAvatarRevision, validateAvatarImage } from './avatars.js'
import { identifier, requireThat } from './protocol.js'

export const GROUP_AVATAR_LENGTH = 32768
export function setGroupAvatar(store, auth, input) {
  return store.operation(auth,input.operationId,input,()=>{
    const {caller,group}=store.groupActor(auth,input)
    requireThat(['owner','admin'].includes(caller.role),'FORBIDDEN')
    requireThat(Object.keys(input).every(key=>['principalId','conversationId','membershipEpoch','expectedVersion','operationId','image'].includes(key)),'INVALID_REQUEST')
    let imageRevision=null
    if(input.image!==null){
      requireThat(typeof input.image==='string'&&input.image.length<=GROUP_AVATAR_LENGTH,'INVALID_AVATAR_IMAGE')
      validateAvatarImage(input.image);imageRevision=avatarRevision(input.image)
      store.db.prepare('INSERT INTO group_avatars VALUES (?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET revision=excluded.revision,image=excluded.image').run(input.conversationId,imageRevision,input.image)
    }else store.db.prepare('DELETE FROM group_avatars WHERE conversation_id=?').run(input.conversationId)
    store.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(input.conversationId)
    store.event(input.conversationId,'group.avatar.changed',{imageRevision})
    return {conversationId:input.conversationId,membershipVersion:group.version+1,avatar:{imageRevision},updated:true}
  })
}
export function readGroupAvatar(store,auth,input){
  store.member(auth,input.conversationId,input.principalId,input.membershipEpoch)
  requireThat(validAvatarRevision(input.revision),'INVALID_AVATAR_REVISION')
  const row=store.db.prepare('SELECT revision,image FROM group_avatars WHERE conversation_id=?').get(input.conversationId)
  requireThat(row&&row.revision===input.revision,'AVATAR_NOT_FOUND')
  return {conversationId:input.conversationId,revision:row.revision,image:row.image}
}
const text=(value,max)=>typeof value==='string'&&value.isWellFormed()&&[...value].length<=max&&!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)
export function setGroupIdentity(store,auth,input){
  return store.operation(auth,input.operationId,input,()=>{
    const {caller,group}=store.groupActor(auth,input)
    requireThat(['owner','admin'].includes(caller.role),'FORBIDDEN')
    requireThat(Object.keys(input).every(key=>['principalId','conversationId','membershipEpoch','expectedVersion','operationId','targetPrincipalId','identity'].includes(key)),'INVALID_REQUEST')
    identifier(input.targetPrincipalId)
    const target=store.db.prepare('SELECT epoch FROM memberships WHERE conversation_id=? AND principal_id=? AND active=1').get(input.conversationId,input.targetPrincipalId)
    requireThat(target,'NOT_A_MEMBER')
    const value=input.identity
    requireThat(text(value,4000),'INVALID_GROUP_IDENTITY')
    const identity=value.trim()
    store.db.prepare('INSERT INTO group_identities VALUES (?,?,?,?) ON CONFLICT(conversation_id,principal_id) DO UPDATE SET epoch=excluded.epoch,body=excluded.body').run(input.conversationId,input.targetPrincipalId,target.epoch,JSON.stringify(identity))
    store.db.prepare('UPDATE conversations SET version=version+1 WHERE id=?').run(input.conversationId)
    store.event(input.conversationId,'group.identity.changed',{principalId:input.targetPrincipalId,identity})
    return {conversationId:input.conversationId,membershipVersion:group.version+1,principalId:input.targetPrincipalId,identity,updated:true}
  })
}
export function groupIdentity(store,conversationId,principalId){
  const row=store.db.prepare('SELECT g.body FROM group_identities g JOIN memberships m ON m.conversation_id=g.conversation_id AND m.principal_id=g.principal_id AND m.epoch=g.epoch WHERE g.conversation_id=? AND g.principal_id=? AND m.active=1').get(conversationId,principalId)
  return row?JSON.parse(row.body):''
}
export function readGroupIdentity(store,auth,input){
  store.member(auth,input.conversationId,input.principalId,input.membershipEpoch)
  identifier(input.targetPrincipalId)
  requireThat(store.db.prepare('SELECT 1 FROM memberships WHERE conversation_id=? AND principal_id=? AND active=1').get(input.conversationId,input.targetPrincipalId),'NOT_A_MEMBER')
  return {conversationId:input.conversationId,principalId:input.targetPrincipalId,identity:groupIdentity(store,input.conversationId,input.targetPrincipalId)}
}
