import assert from 'node:assert/strict'
import { test } from 'node:test'
import { benchEnvironment, benchOverlay, linuxBenchLaunch, linuxProcessIdentity, ownsLinuxProcess, signalOwnedProcess, validateBenchOptions } from '../dev/communication/bench-linux.mjs'

const options={action:'start',name:'cloud-unit',webPort:3131,mockPort:8831}
test('cross-platform bench validates isolated names, actions and distinct unreserved ports',()=>{
  assert.deepEqual(validateBenchOptions(options),options)
  for(const change of [{name:'../personal'},{name:''},{action:'reset'},{webPort:3080},{mockPort:3131},{webPort:65536},{webPort:1.5}])assert.throws(()=>validateBenchOptions({...options,...change}),/INVALID_BENCH_/)
})
test('Linux child environment excludes ambient real credentials, preserving only local guard and fixtures',()=>{
  const input={PATH:'/bin',HOME:'/synthetic',OPENAI_API_KEY:'synthetic-external-key',DSBOT_COMMUNICATION_OPENAI_INPUT:'synthetic-private-input',OTHER_SECRET:'synthetic-other',NODE_OPTIONS:'--import /unrelated',DSBOT_COMMUNICATION_CREDENTIAL:'synthetic-pairing',DSBOT_OPENAI_LOCAL:'x'.repeat(32),DSBOT_OPENAI_GUARD_URL:'http://127.0.0.1:3456/v1',MOCK_LOG_TOOLS:'1'}
  const host=benchEnvironment(input,'/synthetic/test',options)
  for(const key of ['OPENAI_API_KEY','DSBOT_COMMUNICATION_OPENAI_INPUT','OTHER_SECRET','NODE_OPTIONS'])assert.equal(Object.hasOwn(host,key),false)
  assert.equal(host.DEEPSEEK_API_KEY,'mock-key');assert.equal(host.DSH_HOME,'/synthetic/test')
  assert.equal(host.DSBOT_COMMUNICATION_CREDENTIAL,'synthetic-pairing');assert.equal(host.DSBOT_OPENAI_LOCAL,'x'.repeat(32))
  const mock=benchEnvironment(input,'/synthetic/test',options,{mock:true})
  for(const key of ['DSBOT_COMMUNICATION_CREDENTIAL','DSBOT_OPENAI_LOCAL','DSBOT_OPENAI_GUARD_URL'])assert.equal(Object.hasOwn(mock,key),false)
})
test('Linux overlay accepts only public loopback communication and nonce-authenticated OpenAI guard',()=>{
  assert.match(benchOverlay({}),/checkRatio: 0.45/)
  assert.doesNotMatch(benchOverlay({DSBOT_COMMUNICATION_ONBOARDING_FIXTURE:'1'}),/- id: bot\n/)
  const config=JSON.stringify({enabled:true,url:'ws://127.0.0.1:3190/communication',instanceId:'synthetic'})
  assert.match(benchOverlay({DSBOT_COMMUNICATION_CONFIG:config}),/communication: /)
  for(const value of [{url:'wss://example.com/communication'},{url:'ws://127.0.0.1/?token=x'},{url:'ws://name:secret@127.0.0.1/'},{url:'ws://127.0.0.1/',apiKey:'synthetic'}])assert.throws(()=>benchOverlay({DSBOT_COMMUNICATION_CONFIG:JSON.stringify(value)}),/INVALID_COMMUNICATION_/)
  const guard=benchOverlay({DSBOT_OPENAI_GUARD_URL:'http://127.0.0.1:3456/v1',DSBOT_OPENAI_LOCAL:'x'.repeat(32)})
  assert.match(guard,/id: gpt-6-luna/);assert.match(guard,/maxRetries: 0/);assert.doesNotMatch(guard,/x{32}/)
  assert.throws(()=>benchOverlay({DSBOT_OPENAI_GUARD_URL:'https://api.openai.com/v1',DSBOT_OPENAI_LOCAL:'x'.repeat(32)}),/INVALID_OPENAI_GUARD/)
})
test('Linux ownership rejects unrelated processes, changed birth times and another bench scope',{skip:process.platform!=='linux'},()=>{
  const identity=linuxProcessIdentity(process.pid);assert.ok(identity?.started)
  assert.equal(ownsLinuxProcess({id:process.pid,started:identity.started,script:identity.arguments[1],scope:'cloud-unit'},'cloud-unit'),false)
  assert.equal(ownsLinuxProcess({id:process.pid,started:'0',script:identity.arguments[1],scope:'cloud-unit'},'cloud-unit'),false)
  assert.equal(ownsLinuxProcess({id:process.pid,started:identity.started,script:identity.arguments[1],scope:'another'},'cloud-unit'),false)
  assert.equal(linuxProcessIdentity(-1),null)
})
test('Linux launch uses an OS-held persistent lock and does not inherit Node CLI arguments',()=>{
  const launch=linuxBenchLaunch(options,'/synthetic/supervisor.lock')
  assert.equal(launch.file,'/usr/bin/flock');assert.ok(launch.args.includes('--no-fork'))
  assert.ok(launch.args.includes('--nonblock'));assert.equal(launch.args.at(-2),'--supervise')
  assert.deepEqual(JSON.parse(launch.args.at(-1)),options)
  assert.equal(launch.args.includes('--import'),false);assert.equal(launch.args.includes('--no-warnings'),false)
})
test('concurrent shutdown treats ESRCH as already stopped but preserves other errors',()=>{
  const missing=()=>{throw Object.assign(new Error('already gone'),{code:'ESRCH'})}
  assert.doesNotThrow(()=>signalOwnedProcess(123,'SIGTERM',missing))
  assert.throws(()=>signalOwnedProcess(123,'SIGTERM',()=>{throw Object.assign(new Error('denied'),{code:'EPERM'})}),{code:'EPERM'})
})

test('only an explicit test Hub CA reaches the owned host, never the Mock model', () => {
 const input={NODE_EXTRA_CA_CERTS:'/ambient/unrelated-ca',DSBOT_COMMUNICATION_TEST_CA_FILE:'/synthetic/test-ca.pem'}
 assert.equal(benchEnvironment({},'/synthetic/test',options).NODE_EXTRA_CA_CERTS,undefined)
 assert.equal(benchEnvironment({NODE_EXTRA_CA_CERTS:input.NODE_EXTRA_CA_CERTS},'/synthetic/test',options).NODE_EXTRA_CA_CERTS,undefined)
 const supervisor=benchEnvironment(input,'/synthetic/test',options)
 assert.equal(supervisor.NODE_EXTRA_CA_CERTS,input.DSBOT_COMMUNICATION_TEST_CA_FILE)
 assert.equal(benchEnvironment(supervisor,'/synthetic/test',options).NODE_EXTRA_CA_CERTS,input.DSBOT_COMMUNICATION_TEST_CA_FILE)
 assert.equal(benchEnvironment(input,'/synthetic/test',options,{mock:true}).NODE_EXTRA_CA_CERTS,undefined)
})
