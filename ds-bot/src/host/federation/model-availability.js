import {splitRef} from '../text.js'

// Only export bounded reasons, never provider names, credentials or raw errors.
export async function communicationModel(rt,bot){
  let ref
  try{ref=await rt.desiredModel(bot)}catch{return {error:'MODEL_UNAVAILABLE'}}
  if(!ref)return {error:bot.model?'MODEL_UNAVAILABLE':'MODEL_NOT_CONFIGURED'}
  try{
    const {provider}=splitRef(ref)
    if((await rt.missingKeys?.([provider]))?.has(provider))return {error:'MODEL_CREDENTIAL_MISSING'}
  }catch{return {error:'MODEL_UNAVAILABLE'}}
  return {ref,error:null}
}
export async function communicationModelStates(runtime){
  const states=new Map()
  if(typeof runtime.rt.desiredModel!=='function'||typeof runtime.rt.botOf!=='function')return states
  for(const bot of runtime.bots.values()){
    const local=runtime.rt.botOf(bot.localRef)
    if(local)states.set(bot.principalId,(await communicationModel(runtime.rt,local)).error)
  }
  return states
}
