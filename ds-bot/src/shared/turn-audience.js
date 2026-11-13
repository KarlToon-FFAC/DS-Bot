// An explicit grant covers only ordinary text after its host-observed tool call.
// Earlier internal text and any later remote input stay outside that grant.
export function explicitUserOutput(routing, seq) {
  return routing?.explicit === true && routing.triggerOrigin === 'local-bot'
    && routing.baseAudience === 'internal' && Number.isSafeInteger(routing.userOutputFromSeq)
    && routing.userOutputFromSeq >= 0 && Number.isSafeInteger(seq) && seq >= routing.userOutputFromSeq
    && (routing.userOutputThroughSeq === undefined || Number.isSafeInteger(routing.userOutputThroughSeq) && seq <= routing.userOutputThroughSeq)
}

export function explicitUserStream(routing) {
  return routing?.audience === 'user' && routing.userOutputThroughSeq === undefined
    && explicitUserOutput(routing, routing.userOutputFromSeq)
}

export function outputRouting(routing, seq) {
  if (!routing || routing.explicit !== true) return routing
  return {...routing, audience: explicitUserOutput(routing, seq) ? 'user' : 'internal'}
}
