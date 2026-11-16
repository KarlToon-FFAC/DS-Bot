import {createHash} from 'node:crypto'
export const MAX_AUTO_REPLIES = 32
export function reserveAutomaticReply(rt,id,source,text) {
  const work=rt.state.works?.[source.exchangeId]
  const root=work?.replyChain??source.localReplyChain??source.exchangeId
  if(!root)return {blocked:'LOCAL_REPLY_CREDENTIAL_REQUIRED'}
  const chains=rt.state.localReplyChains??={}, chain=chains[root]??={count:0,receipts:{}}
  const key=createHash('sha256').update(JSON.stringify([rt.selfOf(id),source.exchangeId])).digest('hex')
  const hash=createHash('sha256').update(text).digest('hex'), prior=chain.receipts[key]
  if(prior)return prior.hash!==hash?{blocked:'LOCAL_REPLY_CONFLICT'}:prior.confirmed?{replay:true,root,receiptId:key}:{blocked:'LOCAL_REPLY_DELIVERY_UNKNOWN'}
  const limit=Math.min(MAX_AUTO_REPLIES,rt.localAutoReplyLimit??MAX_AUTO_REPLIES)
  if(chain.count>=limit)return {blocked:'LOCAL_REPLY_BUDGET_EXCEEDED',root}
  const receipt={hash,confirmed:false,at:Date.now()}
  chain.count++;chain.receipts[key]=receipt
  const ready=rt.save({required:true}).catch(error=>{delete chain.receipts[key];chain.count--;throw error})
  return {root,receiptId:key,ready,async confirm(){receipt.confirmed=true;try{await rt.save({required:true,outputDrain:true})}catch(error){receipt.confirmed=false;throw Object.assign(error,{deliveryUncertain:true})}}}
}
