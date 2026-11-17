import {batchTools} from '../src/host/tool-compat.js'
export async function mountToolExecutor(ctx) {
  if(batchTools(ctx.tools))await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
}
export async function executeOne(tools,exec) {
  if(!batchTools(tools))return tools.execute(exec)
  const batch=await tools.execute({calls:[{type:'tool-call',id:exec.callId,name:exec.name,arguments:JSON.stringify(exec.arguments)}],agent:exec.agent,signal:exec.signal,toolSet:exec.toolSet})
  return batch.results[0].result
}
export async function presentTools(scope,mode) {
  if(!batchTools(scope.tools))return scope.tools.presentAs(mode)
  if(mode==='native')return scope.tools.setExecutor(new (await import('@deepseek-ai/dsh-tool-executor-native')).NativeToolExecutor(scope))
  const provider=await import('@deepseek-ai/dsh-tool-executor-ptc')
  return scope.tools.setExecutor(new provider.PtcExecutor(scope))
}
