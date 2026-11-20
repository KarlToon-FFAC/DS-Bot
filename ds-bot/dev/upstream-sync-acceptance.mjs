// Mock-only native DSH acceptance for the upstream group features and layout.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {benchClient,repo} from './communication/bench-client.mjs'
import {until} from './communication/local-topology.mjs'
const name='upstream-group-features-'+randomUUID().slice(0,8),port=3541,mock=9241
const run=promisify(execFile),bench=action=>run(process.execPath,[join(import.meta.dirname,'communication/bench.mjs'),action,name,String(port),String(mock)],{env:process.env})
const saved=()=>JSON.parse(readFileSync(join(repo,`.dsh-test-${name}/bot/state.json`),'utf8'))
let browser
try{
 await bench('start')
 const client=await benchClient(name,port),api=(endpoint,payload={})=>client.request('/api/bot',{endpoint,payload})
 const team=await api('state'),id=team.mainBotId
 await api('update-bot',{id,model:'deepseek-official/deepseek-v4-pro'})
 const teammate=await api('create-bot',{name:'Verifier',model:'deepseek-official/deepseek-v4-pro'})
 const room=await api('create-room',{name:'Upstream feature acceptance',members:[id,teammate.id],admin:id})
 await api('update-room',{id:room.id,mode:'admin'})
 await api('send',{sessionId:room.id,text:'UPSTREAM-GROUP-FEATURES'})
 const current=await until(()=>{const roomState=saved().rooms[room.id];return roomState.todos?.length===1&&Object.values(roomState.tasks??{})[0]?.status==='review'&&roomState.goal?.status==='drafting'&&roomState},'native to-do, task and Goal tools',60000)
 assert.equal(Object.values(current.tasks)[0].progress,'Native DSH tools work')
 await api('room-todo',{roomId:room.id,id:current.todos[0].id,done:true})
 assert.equal(saved().rooms[room.id].todos[0].done,true)
 console.log('PASS real DSH 0.2.2 mock turn registers group_todo, group_task and group_goal; user checkbox updates the same saved to-do')
 if(process.env.DSBOT_PLAYWRIGHT_MODULE){
  const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE)
  browser=await chromium.launch({executablePath:process.env.DSBOT_CHROMIUM_PATH,headless:true})
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  const log=readFileSync(join(repo,`.dsh-test-${name}/web.log`),'utf8'),login=log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  assert.ok(login);await page.goto(login)
  const row=page.locator(`[data-room-id="${room.id}"]`);await row.first().click()
  await page.getByRole('button',{name:'View conversation details',exact:true}).click()
  await page.getByText('Verify the upstream group layout',{exact:true}).waitFor()
  await page.getByText('Verify all group features',{exact:true}).waitFor()
  const out=join(repo,'.dsh-test-tools/upstream-group-layout');mkdirSync(out,{recursive:true})
  await page.screenshot({path:join(out,'wide.png')})
  await page.setViewportSize({width:800,height:680})
  if(!await page.getByText('Verify the upstream group layout',{exact:true}).isVisible())await page.getByRole('button',{name:'View conversation details',exact:true}).click()
  await page.getByText('Verify the upstream group layout',{exact:true}).waitFor()
  await page.getByText('Verify all group features',{exact:true}).waitFor()
  await page.screenshot({path:join(out,'narrow.png')})
  assert.deepEqual(errors,[])
  await browser.close();browser=undefined
  console.log('PASS actual group details render the shared to-do and task board at wide and narrow widths with no browser exceptions')
 }
 await bench('stop');await bench('start');await benchClient(name,port)
 const restored=saved().rooms[room.id]
 assert.equal(restored.todos[0].done,true);assert.equal(Object.values(restored.tasks)[0].status,'review');assert.equal(restored.goal.status,'drafting')
 console.log('PASS to-do, task and Goal survive a real host restart')
}finally{await browser?.close();await bench('stop')}
