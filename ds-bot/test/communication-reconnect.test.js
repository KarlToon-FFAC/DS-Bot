import assert from 'node:assert/strict'
import {test} from 'node:test'
import {CommunicationTransport} from '../src/host/federation/transport.js'
test('scoped network failures reconnect; certificate and identity failures remain terminal',async()=>{
 for(const code of ['HUB_CONNECTION_REFUSED','HUB_CONNECTION_TIMEOUT','HUB_UNREACHABLE','HUB_TLS_UNTRUSTED','UNAUTHENTICATED','HUB_PAUSED']){
  let disconnected=0
  const transport=new CommunicationTransport({disconnected:()=>disconnected++},{url:'wss://example.invalid/communication'})
  transport.connect=async()=>{throw Object.assign(Error(code),{code})}
  transport.start()
  await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(transport.running,['HUB_CONNECTION_REFUSED','HUB_CONNECTION_TIMEOUT','HUB_UNREACHABLE'].includes(code),code)
  assert.equal(disconnected,1)
  transport.stop()
 }
})
