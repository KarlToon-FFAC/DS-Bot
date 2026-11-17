// Both paths use the host's exact public Session observation, never local files.
export async function inspectSession(services,sessionId,signal) {
  signal?.throwIfAborted()
  const query=services.get?.('sessionQuery')??services.sessionQuery
  if(typeof query?.observeSession!=='function'){
    if(typeof services.sessionController?.inspect==='function')return services.sessionController.inspect(sessionId,signal)
    throw Object.assign(new Error('Public Session inspection is unavailable.'),{code:'SESSION_QUERY_UNAVAILABLE'})
  }
  const observation=await query.observeSession(sessionId,{signal,projectionMode:'none'})
  try {
    signal?.throwIfAborted()
    return {session:structuredClone(observation.header),events:structuredClone(observation.events)}
  } finally {observation[Symbol.dispose]()}
}
