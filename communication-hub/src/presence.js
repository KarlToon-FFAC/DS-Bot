import {requireThat,identifier} from './protocol.js'

// Presence is a socket-bound lease, never a durable work/delivery receipt.
export function botPresence(store, authenticated, {now=Date.now, ttl=15000}={}) {
  const reports=new WeakMap()
  const read=person=>{
    if(person.retired||person.kind==='bot'&&!store.isPublished(person.principalId))return {connected:false,working:false}
    for(const [socket,auth] of authenticated){
      if(auth.instanceId!==person.homeInstanceId||socket.readyState!==1)continue
      try{store.check(auth)}catch{continue}
      const report=reports.get(socket)
      if(!report||now()-report.at>=ttl)return {connected:true,working:null}
      return {connected:true,working:report.ids.has(person.principalId),...(report.models.has(person.principalId)?{availabilityError:report.models.get(person.principalId)}:{})}
    }
    return {connected:false,working:false}
  }
  const update=(socket,auth,input)=>{
    requireThat(Array.isArray(input.workingBotPrincipalIds)&&input.workingBotPrincipalIds.length<=store.limits.maxPrincipals,'INVALID_REQUEST')
    const ids=new Set(input.workingBotPrincipalIds)
    for(const id of ids){const person=store.principal(auth,identifier(id));requireThat(person.kind==='bot'&&store.isPublished(id),'BOT_NOT_PUBLISHED')}
    const models=new Map()
    requireThat(input.unavailableBotModels===undefined||Array.isArray(input.unavailableBotModels)&&input.unavailableBotModels.length<=store.limits.maxPrincipals,'INVALID_REQUEST')
    for(const item of input.unavailableBotModels??[]){
      requireThat(item&&typeof item==='object'&&Object.keys(item).every(key=>['principalId','reason'].includes(key))&&['MODEL_NOT_CONFIGURED','MODEL_UNAVAILABLE','MODEL_CREDENTIAL_MISSING'].includes(item.reason),'INVALID_REQUEST')
      const person=store.principal(auth,identifier(item.principalId))
      requireThat(person.kind==='bot'&&store.isPublished(item.principalId),'BOT_NOT_PUBLISHED')
      requireThat(!models.has(item.principalId),'INVALID_REQUEST');models.set(item.principalId,item.reason)
    }
    const previous=reports.get(socket)
    const changed=!previous||previous.ids.size!==ids.size||[...ids].some(id=>!previous.ids.has(id))||previous.models.size!==models.size||[...models].some(([id,reason])=>previous.models.get(id)!==reason)||now()-previous.at>=ttl
    reports.set(socket,{at:now(),ids,models})
    return changed
  }
  return {read,update}
}
