import {test} from 'node:test'
import assert from 'node:assert/strict'
import {inspectSession} from '../src/host/session-inspection.js'
import {inspectBinding} from '../src/host/federation/session-journal.js'

test('legacy Session inspection retains its public controller and cancellation contract',async()=>{
 const signal=new AbortController().signal,result={events:[]}
 assert.equal(await inspectSession({sessionController:{inspect:async(id,cancel)=>{assert.equal(id,'one');assert.equal(cancel,signal);return result}}},'one',signal),result)
})
test('new Session query observations are cloned and disposed for every binding Session',async()=>{
 let disposed=0
 const events=[{type:'turn/start',turn:1}]
 const services={sessionController:{inspect:async()=>assert.fail('new hosts must use their query observation')},sessionQuery:{observeSession:async(id,options)=>{
  assert.equal(options.projectionMode,'none');assert.ok(options.signal)
  return {header:{id},events,[Symbol.dispose](){disposed++}}
 }}}
 const records=await inspectBinding(services,{sessionIds:['one','two']},new AbortController().signal)
 assert.equal(records.length,2);assert.equal(disposed,2)
 assert.deepEqual(records[0].events,events);assert.notEqual(records[0].events,events)
})
test('cancelled and invalid observations fail closed and release their lease',async()=>{
 const abort=new AbortController();let disposed=0
 const services={sessionQuery:{observeSession:async()=>{abort.abort();return {events:[],[Symbol.dispose](){disposed++}}}}}
 await assert.rejects(inspectSession(services,'one',abort.signal),{name:'AbortError'})
 assert.equal(disposed,1)
 await assert.rejects(inspectSession({},'one'),{code:'SESSION_QUERY_UNAVAILABLE'})
})
