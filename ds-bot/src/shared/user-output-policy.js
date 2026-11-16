import {explicitUserOutput} from './turn-audience.js'
// Gateway contract: consume host-authenticated, per-output routing, never text markers.
export function userOutputDecision(item) {
  const routing=item?.routing
  if(!routing)return {allow:false,reason:'routing-absent'}
  if(routing.audience!=='user')return {allow:false,reason:routing.audience==='internal'?'internal':'routing-invalid'}
  if(routing.explicit===true){
    const allowed=routing.triggerOrigin==='local-bot' && (routing.recovered===true && typeof routing.originalOutputId==='string' || explicitUserOutput(routing,item.seq))
    return {allow:allowed,reason:allowed?'explicit':'explicit-outside-range'}
  }
  return {allow:routing.triggerOrigin==='user',reason:routing.triggerOrigin==='user'?'user':'inherited'}
}
