import {createScope} from '@deepseek-ai/dsh-scope'
// DSH 0.2.1 filters assembly schemas; 0.2.2 gives that authority to executors.
export const batchTools = tools => typeof tools?.setExecutor==='function' && typeof tools?.resolve==='function'
export const filterToolPresentation = (assembly,allowed) => ({...assembly,...(Array.isArray(assembly.tools)?{tools:assembly.tools.filter(tool=>allowed(tool.name))}:{})})

export function admittedSubset(registry,agent,original,allowed) {
  let disposed=false
  return {dispose(){disposed=true},view(scope){
    if(disposed||scope!==agent)return new Map()
    const source=original?original.view(scope):new Map(registry.definitions(scope).filter(tool=>registry.executable(tool.name,scope)===tool).map(tool=>[tool.name,tool]))
    return new Map([...source].filter(([name])=>allowed(name)))
  }}
}

export function install(rt) {
  const {ctx}=rt
  if(!batchTools(ctx.tools))return
  const entries=new WeakMap(),disposers=[]
  let closed=false
  rt.ensureBotToolExecutor=async(agent,allowed)=>{
    allowed??=rt.botToolAllowed
    if(!agent?.ctx||!allowed||!rt.isBotSession(agent.id)&&!rt.communication?.owners?.has(agent.id))return
    if(closed)throw Object.assign(new Error('The Bot tool adapter is closed.'),{code:'BOT_TOOL_SCOPE_EXPIRED'})
    const previous=entries.get(agent)
    if(previous){previous.allowed=allowed;return previous.ready}
    const entry={allowed}
    entries.set(agent,entry)
    entry.ready=(async()=>{
      const assembly=await ctx.systemPrompt.assemble({scope:agent,agent})
      const ptc=assembly.tools.some(tool=>tool.name==='run_code')
      const provider=ptc?await import('@deepseek-ai/dsh-tool-executor-ptc'):await import('@deepseek-ai/dsh-tool-executor-native')
      if(closed)throw Object.assign(new Error('The Bot tool adapter is closed.'),{code:'BOT_TOOL_SCOPE_EXPIRED'})
      const owned=createScope(agent.ctx,agent)
      try {
        const base=ptc?new provider.PtcExecutor(owned.ctx):new provider.NativeToolExecutor(owned.ctx)
        const accepts=name=>entry.allowed(name)
        const executor={
          ...(base.sections?{sections:base.sections.map(section=>({...section,...(typeof section.text==='function'?{text:definitions=>section.text(definitions.filter(tool=>accepts(tool.name)))}:{})}))}:{}),
          describe:definitions=>base.describe(definitions.filter(tool=>accepts(tool.name))),
          async execute(input){
            const selected=admittedSubset(ctx.tools,input.agent,input.toolSet,accepts)
            try{return await base.execute({...input,toolSet:selected})}finally{selected.dispose()}
          },
        }
        const dispose=owned.ctx.tools.setExecutor(executor)
        disposers.push(()=>owned.dispose(),dispose)
      } catch(error) {
        await owned.dispose()
        if(error.message==='Only one tool executor may be registered in each scope')throw Object.assign(new Error('The Bot Session already has a scoped tool executor. Select the built-in native or PTC executor in the parent profile instead.'),{code:'BOT_TOOL_EXECUTOR_CONFLICT',cause:error})
        throw error
      }
    })().catch(error=>{entries.delete(agent);throw error})
    return entry.ready
  }
  ctx.effect(()=>async()=>{closed=true;for(const dispose of disposers.splice(0).reverse())await dispose()},'ds-bot: versioned tool executor')
}
