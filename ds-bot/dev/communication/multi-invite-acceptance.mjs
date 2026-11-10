// Real owned DSH Web instances, production client and an isolated Mock/Hub topology.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {LocalTopology,until} from './local-topology.mjs'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const nonce=randomUUID().slice(0,8),topology=new LocalTopology({prefix:`multi-invite-${nonce}`,webPort:3465,mockPort:9165,hubPort:3469})
const output=join(topology.root,`${topology.prefix}-ui`);mkdirSync(output,{recursive:true})
const evidence={status:'RUNNING',model:'deterministic Mock',cases:[]};let browser
try{
 await topology.initialize();const [a,b]=topology.peers
 browser=await chromium.launch({...(process.env.DSBOT_CHROMIUM_PATH?{executablePath:process.env.DSBOT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']})
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',()=>errors.push(true))
 const login=readFileSync(join(a.home,'web.log'),'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${a.web}/\\?token=[^\\s]+`))?.[0]
 assert.ok(login,'owned profile has a login entry')
 await page.goto(login).catch(()=>{throw Error('Owned native client navigation failed')})
 await page.keyboard.press('Escape')
 await page.addStyleTag({content:'.p0-entry,.p0-layout-entry{display:none!important}'})
 await page.screenshot({path:join(output,'native-startup.png')})
 await page.getByRole('button',{name:'Remote communication',exact:true}).click()
 for(const [label,width,height]of [['desktop',1280,900],['mobile',390,844]]){
  await page.setViewportSize({width,height})
  const group=await topology.group('Multi invite '+label+' '+nonce,[])
  if(label==='mobile')await page.getByRole('button',{name:'Conversations',exact:true}).click()
  await page.locator(`[data-conversation-id="${group}"]`).click();await page.locator('.bt-comm-title-pill').click()
  await page.getByRole('button',{name:'Invite participant',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Invite participant',exact:true});await dialog.waitFor()
  assert.equal(await dialog.locator('input[type=radio]').count(),0)
  const choices=dialog.getByRole('checkbox');assert.equal(await choices.count(),2)
  await choices.nth(0).check();await choices.nth(1).check()
  await dialog.getByText('Selected Bots: 2',{exact:true}).waitFor()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await page.screenshot({animations:'disabled',path:join(output,`${label}-select-many.png`)})
  await dialog.getByRole('button',{name:'Invite',exact:true}).click();await dialog.waitFor({state:'detached',timeout:45000})
  const canonical=await until(async()=>{const value=await a.api({endpoint:'members',conversationId:group});return [a.human,a.bot,b.human,b.bot].every(id=>value.members.some(person=>person.principalId===id))&&value},'both selected Bots and canonical owners joined')
  assert.equal(canonical.members.length,4)
  await until(async()=>(await b.api({endpoint:'state'})).conversations.some(item=>item.conversationId===group),'the invited owner sees the actual group')
  await page.screenshot({animations:'disabled',path:join(output,`${label}-joined.png`)})
  evidence.cases.push(`${label}: two native Bots selected and joined with their owners, remote group visible`);console.log('PASS',evidence.cases.at(-1))
  await page.getByRole('button',{name:'Close member settings',exact:true}).first().click()
 }
 assert.equal(errors.length,0);evidence.status='PASS'
}catch(error){evidence.status='FAIL';evidence.error=error.code??error.message;throw error}
finally{await browser?.close();await topology.close();writeFileSync(join(output,'evidence.json'),JSON.stringify(evidence,null,2))}
