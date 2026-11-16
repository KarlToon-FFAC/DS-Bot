import assert from 'node:assert/strict'
import {test} from 'node:test'
import {migrateOutput,addVisibility,outputPending,settleOutput,isUserSubmitted} from '../src/host/output-records.js'
import {reserveAutomaticReply} from '../src/host/local-reply-budget.js'

test('legacy classification is not proof of exposure; actual visibility survives delivery and pending decisions',()=>{
 const row=migrateOutput({id:'old',botId:'a',status:'submitted-user',at:10,routes:[{status:'delivered-auto'}]})
 assert.equal(row.routingSchemaVersion,2);assert.equal(isUserSubmitted(row),false)
 assert.equal(row.visibility[0].confirmed,false);assert.equal(row.deliveries[0].confirmed,true)
 const fact={id:'frame',channel:'user-output',confirmed:true,at:20}
 addVisibility(row,fact);addVisibility(row,fact)
 settleOutput(row,'delivered-auto');outputPending(row,'new-target-needed')
 assert.equal(isUserSubmitted(row),true);assert.equal(row.visibility.length,2)
 assert.equal(row.deliveries.length,1);assert.equal(row.pending.owner,'self')
 assert.equal(row.legacyStatus,'submitted-user')
})

test('automatic return reserves a durable causal budget, deduplicates confirmed receipts and defers uncertainty',async()=>{
 const rt={state:{works:{}},selfOf:id=>id,save:async()=>{},localAutoReplyLimit:2}
 const source={exchangeId:'one',localReplyChain:'root'}
 const first=reserveAutomaticReply(rt,'a',source,'answer');await first.ready
 assert.equal(reserveAutomaticReply(rt,'a',source,'answer').blocked,'LOCAL_REPLY_DELIVERY_UNKNOWN')
 await first.confirm()
 assert.equal(reserveAutomaticReply(rt,'a',source,'answer').replay,true)
 assert.equal(reserveAutomaticReply(rt,'a',source,'changed').blocked,'LOCAL_REPLY_CONFLICT')
 const second=reserveAutomaticReply(rt,'b',{exchangeId:'two',localReplyChain:'root'},'long or short');await second.ready;await second.confirm()
 assert.equal(reserveAutomaticReply(rt,'a',{exchangeId:'three',localReplyChain:'root'},'ok').blocked,'LOCAL_REPLY_BUDGET_EXCEEDED')
 assert.equal(rt.state.localReplyChains.root.count,2)
 assert.equal(reserveAutomaticReply(rt,'a',{},'ok').blocked,'LOCAL_REPLY_CREDENTIAL_REQUIRED')
})

test('failed reservation cannot spend budget or authorize a send, and a failed post-send save stays uncertain',async()=>{
 let fails=true
 const rt={state:{works:{}},selfOf:id=>id,save:async()=>{if(fails)throw new Error('disk')}}
 const source={exchangeId:'request'}
 await assert.rejects(reserveAutomaticReply(rt,'a',source,'answer').ready,/disk/)
 assert.equal(rt.state.localReplyChains.request.count,0)
 fails=false
 const reservation=reserveAutomaticReply(rt,'a',source,'answer');await reservation.ready
 fails=true;await assert.rejects(reservation.confirm(),{deliveryUncertain:true})
 assert.equal(reserveAutomaticReply(rt,'a',source,'answer').blocked,'LOCAL_REPLY_DELIVERY_UNKNOWN')
})
