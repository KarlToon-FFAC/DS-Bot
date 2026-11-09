import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo=resolve(import.meta.dirname,'../../..'),script=join(import.meta.dirname,'bench-linux.mjs')
const workerScripts=new Set([script,join(repo,'ds-bot/dev/mock-llm.mjs'),join(import.meta.dirname,'host.mjs')])
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const fail=code=>{throw new Error(code)}
export function validateBenchOptions({action,name,webPort,mockPort}){
  if(!['start','stop','status'].includes(action)||typeof name!=='string'||!/^[a-z0-9-]{1,96}$/.test(name))fail('INVALID_BENCH_OPTIONS')
  if(![webPort,mockPort].every(port=>Number.isInteger(port)&&port>=1024&&port<=65535&&port!==3080)||webPort===mockPort)fail('INVALID_BENCH_PORTS')
  return {action,name,webPort,mockPort}
}
export function linuxProcessIdentity(pid){
  if(!Number.isSafeInteger(pid)||pid<1)return null
  try{
    const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ')
    if(fields[0]==='Z')return null
    return {id:pid,started:fields[19],executable:readlinkSync(`/proc/${pid}/exe`),arguments:readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0')}
  }catch{return null}
}
export function ownsLinuxProcess(entry,scope){
  if(!entry||typeof entry.started!=='string'||!workerScripts.has(entry.script)||entry.scope!==scope)return false
  const current=linuxProcessIdentity(entry.id)
  if(!current||current.started!==entry.started||current.executable!==realpathSync(process.execPath)||current.arguments[1]!==entry.script)return false
  if(entry.script!==script)return current.arguments[2]==='--bench-scope'&&current.arguments[3]===scope
  try{return current.arguments[2]==='--supervise'&&JSON.parse(current.arguments[3]).name===scope}catch{return false}
}
const entryFor=(pid,name,worker,port,scope)=>{const identity=linuxProcessIdentity(pid);if(!identity)fail('BENCH_CHILD_EXITED');return {name,id:pid,started:identity.started,script:worker,port,scope}}
const locations=options=>{const home=join(repo,`.dsh-test-${options.name}`);return {home,manifest:join(home,'processes.linux.json'),lock:join(home,'supervisor.lock')}}
const readManifest=path=>{if(!existsSync(path))return [];const data=JSON.parse(readFileSync(path,'utf8'));if(data.version!==1||!Array.isArray(data.processes))fail('INVALID_BENCH_MANIFEST');return data.processes}
const atomicJson=(path,value)=>{const temporary=path+'.tmp';writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temporary,path)}
export function benchEnvironment(environment,home,options,{mock=false}={}){
  const allowed=new Set(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','TEMP','TMP','DISPLAY','XDG_RUNTIME_DIR','DSBOT_COMMUNICATION_CONFIG','DSBOT_COMMUNICATION_ONBOARDING_FIXTURE','DSBOT_COMMUNICATION_CREDENTIAL','DSBOT_OPENAI_GUARD_URL','DSBOT_OPENAI_LOCAL','DSBOT_WEB_OPEN','DSBOT_COMMUNICATION_TEST_LIFETIME_MS'])
  const env=Object.fromEntries(Object.entries(environment).filter(([key])=>allowed.has(key)||/^MOCK_[A-Z_]+$/.test(key)))
  Object.assign(env,{DSH_HOME:home,MOCK_PORT:String(options.mockPort),MOCK_LOG:join(home,'mock.jsonl'),MOCK_DELAY_MS:'300',DEEPSEEK_BASE_URL:`http://127.0.0.1:${options.mockPort}/v1`,DEEPSEEK_API_KEY:'mock-key',DSH_TELEMETRY_DISABLED:'1',DSBOT_COMMUNICATION_PROBE:'1',DSBOT_COMMUNICATION_TEST_LOOPBACK:'1',DSBOT_WEB_PORT:String(options.webPort),NO_PROXY:'localhost,127.0.0.1,::1',no_proxy:'localhost,127.0.0.1,::1',DSBOT_COMMUNICATION_OWNER_PID:String(process.pid)})
  if(!mock && environment.DSBOT_COMMUNICATION_TEST_CA_FILE){
    env.DSBOT_COMMUNICATION_TEST_CA_FILE=environment.DSBOT_COMMUNICATION_TEST_CA_FILE
    env.NODE_EXTRA_CA_CERTS=environment.DSBOT_COMMUNICATION_TEST_CA_FILE
  }
  if(mock){delete env.DSBOT_COMMUNICATION_CREDENTIAL;delete env.DSBOT_COMMUNICATION_CONFIG;delete env.DSBOT_OPENAI_LOCAL;delete env.DSBOT_OPENAI_GUARD_URL}
  return env
}
export function benchOverlay(environment){
  let communication=''
  if(environment.DSBOT_COMMUNICATION_CONFIG){
    const config=JSON.parse(environment.DSBOT_COMMUNICATION_CONFIG),allowed=['enabled','url','credentialEnv','publishedBotIds','remoteWorkApproval','humanDisplayName','instanceId','autoAcceptBotInvites','pollMs','contextHistoryBytes','rotateTokens']
    if(Object.keys(config).some(key=>!allowed.includes(key)))fail('INVALID_COMMUNICATION_CONFIG')
    const url=new URL(config.url)
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['ws:','wss:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('INVALID_COMMUNICATION_URL')
    communication=`    communication: ${JSON.stringify(config)}\n`
  }
  if(environment.DSBOT_COMMUNICATION_ONBOARDING_FIXTURE==='1'&&communication)fail('INVALID_ONBOARDING_CONFIG')
  let overlay='- id: session-log-deepseek\n  config:\n    enabled: false\n'
  if(environment.DSBOT_COMMUNICATION_ONBOARDING_FIXTURE!=='1')overlay+='- id: bot\n  config:\n    checkRatio: 0.45\n'+communication
  overlay+='- id: llm-deepseek\n  config:\n    models:\n      - { id: deepseek-flash, contextWindow: 100000, maxTokens: 8000, inputModalities: [text, image] }\n      - { id: deepseek-v4-pro, contextWindow: 100000, maxTokens: 8000 }\n'
  if(environment.DSBOT_OPENAI_GUARD_URL){
    const url=new URL(environment.DSBOT_OPENAI_GUARD_URL)
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/v1'||url.search||url.hash||url.username||url.password||(environment.DSBOT_OPENAI_LOCAL?.length??0)<32)fail('INVALID_OPENAI_GUARD')
    overlay+=`- id: session-title-llm\n  disabled: true\n- id: llm-pi-ai\n  config:\n    providers:\n      comm-openai-pilot:\n        api: openai-responses\n        baseURL: ${JSON.stringify(url.href.replace(/\/$/,''))}\n        apiKeyEnv: DSBOT_OPENAI_LOCAL\n        reasoning: off\n        transport: sse\n        cacheRetention: none\n        timeoutMs: 60000\n        streamIdleTimeoutMs: 60000\n        retryPolicy: { mode: normal, maxRetries: 0 }\n        models:\n          - id: gpt-6-luna\n            contextWindow: 1050000\n            maxTokens: 1024\n            input: [text]\n            reasoningEfforts: { off: none, low: low }\n`
  }
  return overlay
}
async function portUnused(port){
  await new Promise((accept,reject)=>{const server=createServer();server.once('error',()=>reject(new Error('BENCH_PORT_IN_USE')));server.listen(port,'127.0.0.1',()=>server.close(accept))})
}
async function stopEntries(entries,scope){
  let failed=false
  for(const entry of [...entries].reverse()){
    try{
      if(!ownsLinuxProcess(entry,scope))continue
      signalOwnedProcess(entry.id,'SIGTERM')
      const deadline=Date.now()+10000
      while(ownsLinuxProcess(entry,scope)&&Date.now()<deadline)await sleep(50)
      if(ownsLinuxProcess(entry,scope))signalOwnedProcess(entry.id,'SIGKILL')
    }catch{failed=true}
  }
  if(failed)fail('BENCH_STOP_FAILED')
}
export function signalOwnedProcess(pid,signal,kill=process.kill){try{kill(pid,signal)}catch(error){if(error.code!=='ESRCH')throw error}}
export function linuxBenchLaunch(options,lock){
  // flock owns the persistent inode until the supervisor exits; never unlink it.
  return {file:'/usr/bin/flock',args:['--exclusive','--nonblock','--conflict-exit-code','73','--no-fork',lock,process.execPath,script,'--supervise',JSON.stringify(options)]}
}
export async function runLinuxBench(options){
  const {home,manifest,lock}=locations(options),entries=readManifest(manifest)
  if(options.action==='status'){process.stdout.write(JSON.stringify(entries.map(entry=>({name:entry.name,id:entry.id,running:ownsLinuxProcess(entry,options.name),port:entry.port})))+'\n');return}
  if(options.action==='stop'){await stopEntries(entries,options.name);process.stdout.write('Owned bench stopped; test data retained.\n');return}
  if(entries.some(entry=>ownsLinuxProcess(entry,options.name)))fail('BENCH_ALREADY_RUNNING')
  mkdirSync(home,{recursive:true,mode:0o700})
  if(!existsSync('/usr/bin/flock'))fail('BENCH_FLOCK_REQUIRED')
  const fd=openSync(lock,'a',0o600);closeSync(fd)
  const env=benchEnvironment(process.env,home,options)
  if(process.env.DSBOT_COMMUNICATION_OWNER_PID)env.DSBOT_BENCH_PARENT_PID=process.env.DSBOT_COMMUNICATION_OWNER_PID
  const launch=linuxBenchLaunch(options,lock)
  // spawn with explicit arguments excludes inherited process.execArgv and preloads.
  const child=spawn(launch.file,launch.args,{detached:true,stdio:['ignore','ignore','ignore','ipc'],env})
  try{
    await new Promise((accept,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(new Error('BENCH_START_TIMEOUT'))},95000)
      const message=value=>{if(value?.type==='ready'){cleanup();accept()}else if(value?.type==='failed'){cleanup();reject(new Error(value.code))}}
      const exited=code=>{cleanup();reject(new Error(code===73?'BENCH_ALREADY_RUNNING':'BENCH_START_FAILED'))}
      const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exited);child.off('error',exited)}
      child.on('message',message);child.once('exit',exited);child.once('error',exited)
    })
    process.stdout.write(`Ready: http://127.0.0.1:${options.webPort} (login token stays in isolated web.log)\n`)
    child.disconnect();child.unref()
  }catch(error){if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');signalOwnedProcess(child.pid,'SIGTERM');await done}throw error}
}
async function supervise(options){
  const {home,manifest}=locations(options),entries=[],workers=[],parent=linuxProcessIdentity(Number(process.env.DSBOT_BENCH_PARENT_PID))
  let closing=false
  const close=async()=>{if(closing)return;closing=true;let code=0;try{await stopEntries(entries,options.name)}catch{code=1}finally{process.exit(code)}}
  process.on('SIGTERM',close);process.on('SIGINT',close)
  try{
    // Publish ownership before the first asynchronous port/dependency/startup step.
    atomicJson(manifest,{version:1,processes:[entryFor(process.pid,'supervisor',script,0,options.name)]})
    if(process.env.DSBOT_BENCH_PARENT_PID&&!parent)fail('INVALID_OWNED_PARENT')
    const duration=Number(process.env.DSBOT_COMMUNICATION_TEST_LIFETIME_MS??900000)
    if(!Number.isSafeInteger(duration)||duration<60000||duration>14400000)fail('INVALID_OWNED_LIFETIME')
    await portUnused(options.webPort);await portUnused(options.mockPort)
    if(!existsSync(join(repo,'ds-bot/dev/harness/node_modules/@deepseek-ai/dsh/lib/bin.js')))fail('BENCH_DEPENDENCIES_MISSING')
    mkdirSync(join(home,'workspace'),{recursive:true,mode:0o700})
    writeFileSync(join(home,'bench.patch.yml'),benchOverlay(process.env),{mode:0o600})
    for(const [name,worker,port] of [['mock',join(repo,'ds-bot/dev/mock-llm.mjs'),options.mockPort],['web',join(import.meta.dirname,'host.mjs'),options.webPort]]){
      const out=openSync(join(home,name+'.log'),'w',0o600),err=openSync(join(home,name+'.err'),'w',0o600)
      let child
      try{child=spawn(process.execPath,[worker,'--bench-scope',options.name],{cwd:join(home,'workspace'),env:benchEnvironment(process.env,home,options,{mock:name==='mock'}),stdio:['ignore',out,err]});await once(child,'spawn')}finally{closeSync(out);closeSync(err)}
      workers.push(child);entries.push(entryFor(child.pid,name,worker,port,options.name))
      atomicJson(manifest,{version:1,processes:[entryFor(process.pid,'supervisor',script,0,options.name),...entries]})
    }
    const deadline=Date.now()+90000
    while(Date.now()<deadline){
      if(workers.some(child=>child.exitCode!==null||child.signalCode!==null))fail('BENCH_CHILD_EXITED')
      if(readFileSync(join(home,'web.log'),'utf8').includes('dsh web: http'))break
      await sleep(100)
    }
    if(Date.now()>=deadline)fail('BENCH_START_TIMEOUT')
    const expires=Date.now()+duration
    setInterval(()=>{if(Date.now()>=expires||workers.some(child=>child.exitCode!==null||child.signalCode!==null)||(parent&&linuxProcessIdentity(parent.id)?.started!==parent.started))void close()},250)
    process.send({type:'ready'})
  }catch(error){process.send?.({type:'failed',code:/^[A-Z_]+$/.test(error.message)?error.message:'BENCH_START_FAILED'});await close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&process.argv[2]==='--supervise')await supervise(validateBenchOptions(JSON.parse(process.argv[3])))
