import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {benchClient,repo} from './bench-client.mjs'
import {until} from './local-topology.mjs'
const tag=randomUUID().slice(0,8),name=`turn-publication-${tag}`,port=3493,mock=9193
const bench=action=>new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[join(import.meta.dirname,'bench.mjs'),action,name,String(port),String(mock)],{stdio:['ignore','ignore','pipe'],env:{...process.env,DSBOT_WEB_OPEN:'0',MOCK_LOG_TOOLS:'1'}})
 child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Owned publication bench failed')))
})
const abort=new AbortController(),received=[]
let consume, browser, page
const browserErrors=[]
try{
 await bench('start')
 const client=await benchClient(name,port)
 await client.request('/api/bot',{endpoint:'update-bot',payload:{id:client.identity.botId,model:'deepseek-official/deepseek-v4-pro'}})
 const bot=await client.request('/api/bot',{endpoint:'create-bot',payload:{name:'Reporter',role:'Reporter',model:'deepseek-official/deepseek-v4-pro'}})
 if(process.env.DSBOT_PLAYWRIGHT_MODULE){
  const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE)
  browser=await chromium.launch({...(process.env.DSBOT_CHROMIUM_PATH?{executablePath:process.env.DSBOT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']})
  page=await browser.newPage({viewport:{width:1280,height:900}})
  page.on('pageerror',error=>browserErrors.push(error.message))
  const log=readFileSync(join(repo,`.dsh-test-${name}`,'web.log'),'utf8')
  const login=log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  assert.ok(login)
  try{await page.goto(login)}catch{throw new Error('Owned browser login failed')}
  await page.locator(`[data-bot-id="${bot.id}"]`).first().click({timeout:30000})
 }
 const response=await client.subscribe(`/api/bot/user-output?botId=${encodeURIComponent(bot.id)}`,abort.signal)
 assert.equal(response.status,200)
 consume=(async()=>{
  const decoder=new TextDecoder();let buffer=''
  for await(const bytes of response.body){buffer+=decoder.decode(bytes,{stream:true});let end
   while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2)
    if(block.startsWith('event: user-output\n'))received.push(JSON.parse(block.split('\ndata: ')[1]))
   }
  }
 })().catch(error=>{if(!abort.signal.aborted)throw error})
 const send=async(mode,suffix)=>{
  const marker=`${tag}-${suffix}`
  await client.request('/api/bot',{endpoint:'send',payload:{sessionId:client.identity.botId,text:`TURN-USER-DELEGATE ${mode} ${marker}`}})
  return marker
 }
 const first=await send('PUBLISH','first')
 await until(()=>received.some(row=>row.item.text===`PUBLIC_USER_REPORT_${first}`),'native explicit local report reaches canonical mirror feed',60000)
 const control=await send('INTERNAL','control')
 await until(()=>{
  const rows=readFileSync(join(repo,`.dsh-test-${name}`,'mock.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  return rows.some(row=>row.session===bot.id&&JSON.stringify(row.out).includes(`CONTROL_INTERNAL_${control}`))
 },'unmarked internal control completes',60000)
 const last=await send('PUBLISH','last')
 await until(()=>received.some(row=>row.item.text===`PUBLIC_USER_REPORT_${last}`),'later explicit report after the hidden control',60000)
 const state=JSON.parse(readFileSync(join(repo,`.dsh-test-${name}`,'bot/state.json'),'utf8'))
 const grants=Object.values(state.turnAudiences[bot.id]).filter(row=>row.explicit===true)
 assert.equal(grants.length,2)
 assert.ok(grants.every(row=>row.triggerOrigin==='local-bot'&&Number.isSafeInteger(row.userOutputFromSeq)))
 const chat=await client.request('/api/bot',{endpoint:'chat',payload:{botId:bot.id}})
 assert.ok(chat.items.some(row=>row.text===`PUBLIC_USER_REPORT_${first}`))
 assert.ok(chat.items.some(row=>row.text===`PUBLIC_USER_REPORT_${last}`))
 assert.doesNotMatch(JSON.stringify({chat:chat.items,received}),/INTERNAL_BEFORE_PUBLICATION_|CONTROL_INTERNAL_/)
 assert.equal(received.filter(row=>row.item.text?.startsWith('PUBLIC_USER_REPORT_')).length,2)
 if(page){
  await page.getByText(`PUBLIC_USER_REPORT_${first}`,{exact:true}).waitFor({timeout:15000})
  await page.getByText(`PUBLIC_USER_REPORT_${last}`,{exact:true}).waitFor({timeout:15000})
  assert.doesNotMatch(await page.locator('body').innerText(),/INTERNAL_BEFORE_PUBLICATION_|CONTROL_INTERNAL_/)
  assert.deepEqual(browserErrors,[])
  if(process.env.DSBOT_SCREENSHOT_PATH)await page.screenshot({path:process.env.DSBOT_SCREENSHOT_PATH})
  console.log('PASS native browser shows only explicit user reports live without reload; zero page errors')
 }
 console.log('PASS native local Bot-triggered explicit report reaches chat and user-output with durable metadata')
 console.log('PASS preceding internal text, unmarked control and later turns do not inherit publication')
}finally{abort.abort();await consume;await browser?.close();await bench('stop')}
