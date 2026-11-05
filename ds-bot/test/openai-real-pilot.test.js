import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync,readFileSync,readdirSync,rmSync } from 'node:fs'
import { join,resolve,dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { runPilot,startPilotMock } from '../dev/communication/openai-real-pilot.mjs'

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'dsbot-openai-pilot-'))
  t.after(()=>{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(directory.includes('dsbot-openai-pilot-'));rmSync(directory,{recursive:true,force:true})})
  return {directory,credential:'synthetic-'+randomBytes(32).toString('hex')}
}

test('fixed pilot uses private synthetic input, seven loopback requests, sanitized files and closes all owned resources',async t=>{
  const input=fixture(t),result=await runPilot({...input,mode:'mock'})
  assert.equal(result.status,'PASS_PILOT_MOCK');assert.equal(result.actualRequests,7)
  assert.equal(result.reservedRequests,7);assert.equal(result.reservedMicroUsd,10536)
  assert.equal(result.cases.length,3);assert.equal(result.cleanup,true)
  assert.equal(result.mock.allAuthorized,true);assert.equal(result.mock.keyInPayload,false)
  assert.equal(result.realFederationWithDsh,false)
  for(const file of readdirSync(input.directory)) assert.equal(readFileSync(join(input.directory,file)).includes(Buffer.from(input.credential)),false)
  assert.equal(readdirSync(input.directory).includes('running.lock'),false)
  assert.ok(result.modeledGenerationCostUsdUpperBound<0.02)
})

test('authentication, count, unknown dispatch and reply failures stop immediately without retry or logging poisoned secret responses',async t=>{
  for(const [mockFailure,requests,code] of [['auth',1,'MODEL_ACCESS_UNVERIFIED'],['over-input',2,'INPUT_BUDGET_EXCEEDED'],
    ['disconnect',3,'UPSTREAM_REQUEST_FAILED'],['reply',3,'MODEL_REPLY_UNEXPECTED']]){
    const input=fixture(t),result=await runPilot({...input,mode:'mock',mockFailure})
    assert.equal(result.status,'STOPPED');assert.equal(result.actualRequests,requests);assert.equal(result.code,code)
    assert.equal(result.cleanup,true);assert.equal(result.cases.length,0)
    assert.equal(JSON.stringify(result).includes(input.credential),false)
    for(const file of readdirSync(input.directory)) assert.equal(readFileSync(join(input.directory,file)).includes(Buffer.from(input.credential)),false)
  }
})

test('reopening the same run cannot reset the budget, issue more calls or overwrite the original result',async t=>{
  const input=fixture(t)
  await runPilot({...input,mode:'mock'})
  const original=readFileSync(join(input.directory,'result.json'),'utf8')
  const again=await runPilot({...input,mode:'mock'})
  assert.equal(again.status,'STOPPED');assert.equal(again.code,'PILOT_ALREADY_STARTED')
  assert.equal(again.actualRequests,0);assert.equal(again.reservedRequests,7)
  assert.equal(readFileSync(join(input.directory,'result.json'),'utf8'),original)
})

test('loopback rehearsal refuses every credential without the synthetic prefix before opening a destination',async()=>{
  await assert.rejects(startPilotMock('never-a-real-key-but-not-synthetic'),{code:'MOCK_REQUIRES_SYNTHETIC_KEY'})
  await assert.rejects(runPilot({mode:'mock',credential:'never-a-real-key-but-not-synthetic'}),{code:'MOCK_REQUIRES_SYNTHETIC_KEY'})
})
