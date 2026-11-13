import {loadBaselineInstructions} from '@deepseek-ai/dsh-agent-instructions'
import {attachedSkills} from '../skill-tools.js'
import {searchHistory} from './history-search.js'
const fail=code=>{throw Object.assign(new Error(code),{code})}
export function owningBot(runtime,exec){
 const binding=runtime.owners.get(exec.agent?.id)
 const id=binding?.localBotRef??runtime.rt.selfOf(exec.agent?.id),bot=runtime.rt.botOf(id)
 if(!bot)fail('FORBIDDEN')
 return bot
}
export function ownSkills(runtime,bot){
 return attachedSkills(runtime.rt,bot)
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
