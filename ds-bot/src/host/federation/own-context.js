import {loadBaselineInstructions} from '@deepseek-ai/dsh-agent-instructions'
import {searchHistory} from './history-search.js'
const fail=code=>{throw Object.assign(new Error(code),{code})}
export function owningBot(runtime,exec){
 const binding=runtime.owners.get(exec.agent?.id)
 const id=binding?.localBotRef??runtime.rt.selfOf(exec.agent?.id),bot=runtime.rt.botOf(id)
 if(!bot)fail('FORBIDDEN')
 return bot
}
export function ownSkills(runtime,bot){
 const names=new Set(runtime.rt.expandCapabilities?.(bot.capabilities??[])??bot.capabilities??[])
 return [...names].map(name=>runtime.rt.state.capabilities?.items?.[name]).filter(item=>item?.kind==='skill')
}
export function readOwnSkill(runtime,input,exec){
 const skills=ownSkills(runtime,owningBot(runtime,exec))
 if(input.name===undefined)return {skills:skills.map(({name,description})=>({name,description}))}
 const skill=skills.find(item=>item.name===input.name)
 if(!skill)fail('OWN_SKILL_UNAVAILABLE')
 return {name:skill.name,description:skill.description,content:skill.content,audience:'internal'}
}
export async function saveOwnSkill(runtime,input,exec){
 const bot=owningBot(runtime,exec),existing=runtime.rt.state.capabilities?.items?.[input.name]
 if(typeof input.content!=='string'||input.content.length>65536||typeof input.description!=='string'||input.description.length>2000)fail('INVALID_REQUEST')
 if(existing&&(existing.kind!=='skill'||!ownSkills(runtime,bot).some(item=>item.name===input.name)&&existing.createdBy!==bot.id))fail('OWN_SKILL_UNAVAILABLE')
 const item=await runtime.rt.capabilitySave({name:input.name,kind:'skill',description:input.description,content:input.content},{botId:bot.id})
 await runtime.rt.changeCapabilityAttachment('attach',{name:item.name},bot.id)
 return {name:item.name,saved:true,attached:true,effective:'next model request in local and remote Sessions'}
}
export async function ownWorkspaceGuidance(runtime,bot,cwd){
 const fs=runtime.ctx.get?.('fs')
 if(!fs)return ''
 const guidance=await loadBaselineInstructions({cwd,maxBytes:16384,signal:AbortSignal.timeout(10000)},fs)
 return guidance?.text??''
}
export function ownRemoteHistory(runtime,input,exec){
 const bot=owningBot(runtime,exec),principals=new Set()
 for(const [id,person] of runtime.bots)if(id===bot.id)principals.add(person.principalId)
 for(const person of runtime.queue.retiredBots?.()??[])if(person.localRef===bot.id)principals.add(person.principalId)
 let contexts=runtime.queue.memberships().filter(member=>principals.has(member.principalId))
 if(input.conversationId!==undefined)contexts=contexts.filter(member=>member.conversationId===input.conversationId)
 for(const member of contexts)runtime.member(member.principalId,member.conversationId,member.membershipEpoch)
 if(input.query!==undefined)return {...searchHistory(runtime.queue,contexts,input),audience:'internal',scope:'own-bot'}
 if(input.conversationId===undefined)return {conversations:contexts.map(member=>({conversationId:member.conversationId,title:runtime.conversations.get(member.conversationId)?.title??member.title,kind:member.kind,membershipEpoch:member.membershipEpoch})),audience:'internal'}
 const member=contexts[0]
 if(!member)fail('NOT_A_MEMBER')
 return {...runtime.history(member.principalId,{...input,membershipEpoch:member.membershipEpoch}),audience:'internal'}
}
