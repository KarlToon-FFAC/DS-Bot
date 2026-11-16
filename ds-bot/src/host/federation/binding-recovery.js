const safeCode=code=>typeof code==='string'&&(/^(?:session|agent-preset|scope|gateway)\/[a-z-]{1,64}$/.test(code)||/^SESSION_QUERY_[A-Z_]{1,64}$/.test(code)||['ENOENT','EACCES','EPERM','EBUSY','EIO','ABORT_ERR','TIMEOUT'].includes(code))?code:undefined
const locationOf=error=>typeof error?.stack==='string'?error.stack.match(/\b(?:tools|runtime|work-tools|session-scope|store|capabilities|delivery|memory|binding-recovery)\.js:\d+:\d+/)?.[0]:undefined
export function bindingFailure(error,stage,sessionId) {
  const publicCode=safeCode(error?.code)
  return Object.assign(new Error('The remote execution Session could not be prepared. Inspect local binding diagnostics; do not reset or blindly resend.'),{
    code:'COMMUNICATION_SESSION_UNAVAILABLE',bindingStage:stage,sessionId,
    hostCode:publicCode,bindingLocation:locationOf(error),errorClass:['TypeError','RangeError','SyntaxError','Error','RemoteError','AbortError'].includes(error?.name)?error.name:'Error',cause:error,
  })
}
export function safeBindingFailure(error,stage) {
  return {stage:error?.bindingStage??stage,...(typeof error?.toolName==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(error.toolName)?{toolName:error.toolName}:{}),...( ['reserved-transport','scope-conflict','registration-failed'].includes(error?.registrationFailure)?{registrationFailure:error.registrationFailure}:{}),...(typeof error?.sessionId==='string'?{sessionId:error.sessionId}:{}),
    ...(safeCode(error?.hostCode??error?.code)?{hostCode:safeCode(error.hostCode??error.code)}:{}),
    ...(error?.bindingLocation||locationOf(error)?{location:error?.bindingLocation??locationOf(error)}:{}),
    errorClass:['TypeError','RangeError','SyntaxError','Error','RemoteError','AbortError'].includes(error?.errorClass??error?.name)?error.errorClass??error.name:'Error'}
}
export async function resolveBindingAgent(runtime,sessionId,stage) {
  let resolved
  try{resolved=await runtime.ctx.sessionController.resolveAgent(sessionId)}catch(error){throw bindingFailure(error,stage,sessionId)}
  if(!resolved?.agent)throw bindingFailure(resolved?.error,stage,sessionId)
  return resolved.agent
}
export async function recoverUnusedBinding(runtime,binding) {
  if(!binding.sessionIds.length)return binding
  const missing=[],surviving=[]
  for(const sessionId of binding.sessionIds){
    let resolved
    try{resolved=await runtime.ctx.sessionController.resolveAgent(sessionId)}catch(error){throw bindingFailure(error,'binding-resolve',sessionId)}
    if(!resolved?.agent){
      if(resolved?.error?.code!=='session/not-found')throw bindingFailure(resolved?.error,'binding-resolve',sessionId)
      missing.push(sessionId)
    }else surviving.push(resolved.agent)
  }
  if(!missing.length)return binding
  if(!runtime.queue.unusedBinding(binding.id))throw Object.assign(bindingFailure({code:'session/not-found'},'binding-history-missing',missing[0]),{code:'COMMUNICATION_SESSION_HISTORY_UNAVAILABLE'})
  for(const agent of surviving){
    if(agent.status!=='idle')throw bindingFailure({code:'session/busy'},'binding-repair',agent.id)
    let inspection
    try{await runtime.ctx.sessions.flush(agent.session);inspection=await runtime.ctx.sessionController.inspect(agent.id,AbortSignal.timeout(15000))}catch(error){throw bindingFailure(error,'binding-inspect',agent.id)}
    if(!Array.isArray(inspection?.events)||inspection.events.some(event=>event.type==='turn/start'||event.type==='user/message'||event.type==='agent/inbox/spliced'))throw Object.assign(bindingFailure({code:'session/admission-unknown'},'binding-repair',agent.id),{code:'COMMUNICATION_BINDING_REPAIR_UNSAFE'})
  }
  if(surviving.some(agent=>agent.status!=='idle'))throw bindingFailure({code:'session/busy'},'binding-repair')
  // No await between the durable proof recheck and replacing exactly these references.
  binding.sessionIds=runtime.queue.repairUnusedBinding(binding.id,binding.sessionIds,missing)
  for(const id of missing)runtime.owners?.delete(id)
  return binding
}
