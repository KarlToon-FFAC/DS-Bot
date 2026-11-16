// An explicit grant covers only ordinary text after its host-observed tool call.
// Earlier internal text and any later remote input stay outside that grant.
export function explicitUserOutput(routing, seq) {
  if(routing?.explicit===true && ['local-bot','schedule'].includes(routing.triggerOrigin) && routing.baseAudience==='internal' && Number.isSafeInteger(seq) && seq>=0 && (Number.isSafeInteger(routing.userOutputBeforeSeq)&&seq<=routing.userOutputBeforeSeq || (routing.priorUserOutputRanges??[]).some(([from,to])=>Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&seq>=from&&seq<=to)))return true
  return routing?.explicit === true && ['local-bot','schedule'].includes(routing.triggerOrigin)
    && routing.baseAudience === 'internal' && Number.isSafeInteger(routing.userOutputFromSeq)
    && routing.userOutputFromSeq >= 0 && Number.isSafeInteger(seq) && seq >= routing.userOutputFromSeq
    && (routing.userOutputThroughSeq === undefined || Number.isSafeInteger(routing.userOutputThroughSeq) && seq <= routing.userOutputThroughSeq)
}

export function explicitUserStream(routing) {
  return routing?.audience === 'user' && routing.userOutputThroughSeq === undefined
    && explicitUserOutput(routing, routing.userOutputFromSeq)
}

export function outputRouting(routing, seq) {
  if (!routing) return routing
  if(routing.userDirectedRequest===true && routing.audience==='user' && routing.protocol==='request' && routing.triggerOrigin==='local-bot')return {...routing,explicit:true,baseAudience:'internal'}
  if(routing.explicit!==true) return routing.userOutputThroughSeq!==undefined && (!Number.isSafeInteger(seq) || seq>routing.userOutputThroughSeq) ? {...routing,audience:'internal'} : routing
  if(Number.isSafeInteger(routing.userOutputBeforeSeq)&&Number.isSafeInteger(seq)&&seq<=routing.userOutputBeforeSeq)return {...routing,audience:'user',triggerOrigin:'user',explicit:false}
  return {...routing, audience: explicitUserOutput(routing, seq) ? 'user' : 'internal'}
}
