import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const moduleUrl=new URL('../dev/communication/owned-parent.mjs',import.meta.url).href
test('owned test worker exits after its dedicated supervisor dies, without affecting other processes',{timeout:10000},async()=>{
  const owner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'})
  let worker
  try{
    await once(owner,'spawn')
    worker=spawn(process.execPath,['--input-type=module','-e',`import { watchOwnedParent } from ${JSON.stringify(moduleUrl)};watchOwnedParent();console.log('ready');setInterval(()=>{},1000)`],
      {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DSBOT_COMMUNICATION_OWNER_PID:String(owner.pid)}})
    await once(worker.stdout,'data')
    const ended=once(worker,'exit')
    owner.kill();await once(owner,'exit')
    const [code]=await ended;assert.equal(code,0)
  }finally{if(owner.exitCode===null&&owner.signalCode===null)owner.kill();if(worker&&worker.exitCode===null&&worker.signalCode===null)worker.kill()}
})
