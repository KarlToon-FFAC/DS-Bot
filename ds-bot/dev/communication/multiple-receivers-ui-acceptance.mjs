// Synthetic identities and public production components; no DSH data or credentials.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdirSync} from 'node:fs'
import {createServer} from 'node:http'
import {resolve,join} from 'node:path'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const root=resolve(import.meta.dirname,'../..'),client=join(root,'src/client'),harness=join(root,'dev/harness/node_modules')
const output=resolve(process.argv[2]??join(root,'../.dsh-test-tools/multiple-receivers-ui'));mkdirSync(output,{recursive:true})
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {CommunicationSurface} from '${client}/communication.js';import {createSource} from '${client}/sources.js';
import {SHELL_CSS} from '${client}/styles.js';import {BOT_SETTINGS_CSS} from '${client}/bot-settings.js';
import {communicationCSS} from '${client}/communication-styles.js';import {communicationDirectoryCSS} from '${client}/communication-directory-styles.js';
const style=document.createElement('style');style.textContent=SHELL_CSS+BOT_SETTINGS_CSS+communicationCSS+communicationDirectoryCSS;document.head.append(style);
const owner={principalId:'human:a:owner',displayName:'Alice',kind:'human',role:'owner',speakingMode:'speak'};
const buddy={principalId:'human:b:owner',displayName:'Buddy',kind:'human',role:'member',speakingMode:'readOnly'};
const bots=[{principalId:'bot:a:local',displayName:'Local testing specialist',ownerPrincipalId:owner.principalId},{principalId:'bot:b:remote',displayName:'Remote integration specialist',ownerPrincipalId:buddy.principalId}].map(bot=>({...bot,kind:'bot',role:'member',speakingMode:'passive',published:true}));
const member={conversationId:'group',title:'Receiving rules review',kind:'group',role:'owner',speakingMode:'speak',ownerPrincipalId:owner.principalId,membershipEpoch:'epoch',membershipVersion:1,joinSeq:1,watermark:0,routingMode:'admin',adminBotPrincipalId:bots[0].principalId,defaultBotPrincipalIds:[bots[0].principalId],info:{members:[owner,buddy,...bots,...Array.from({length:18},(_,index)=>({...bots[1],principalId:'bot:b:extra-'+index,displayName:'Testing specialist '+index}))]}};
const snapshot={enabled:true,connected:true,reconciled:true,multipleDefaultBotsAvailable:true,groupProfilesAvailable:true,instanceId:'a',humanPrincipalId:owner.principalId,contacts:[owner,buddy,...bots],conversations:[member],invites:[],outbox:[],errors:[]},calls=[];window.fixture={snapshot,calls};
const request=async body=>{calls.push(body);switch(body.endpoint){case 'state':return structuredClone(snapshot);case 'history':return {conversationId:'group',membershipEpoch:'epoch',events:[]};case 'contact-requests':case 'contact-relations':return [];case 'save-settings':if(body.routing){member.routingMode=body.routing.mode;member.defaultBotPrincipalIds=body.routing.defaultBotPrincipalIds}if(body.title!==undefined)member.title=body.title;for(const policy of body.policies??[]){Object.assign(member.info.members.find(person=>person.principalId===policy.targetPrincipalId),policy)}member.membershipVersion++;return {conversationId:'group',updated:true,membershipVersion:member.membershipVersion};default:return {}}};
createRoot(document.getElementById('root')).render(React.createElement(CommunicationSurface,{roster:createSource({ready:true,communicationEnabled:true,remoteHubEnabled:true,bots:[]}),surface:createSource({mode:'bot'}),panel:createSource(true),request}));`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:client,loader:'js'},bundle:true,format:'iife',platform:'browser',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"import React from 'react';export const FishLogo=()=>null;export const writeClipboard=()=>{};export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:client,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><body><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
try{
 browser=await chromium.launch({...(process.env.DSBOT_CHROMIUM_PATH?{executablePath:process.env.DSBOT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']})
 for(const [name,viewport]of [['desktop',{width:1280,height:900}],['mobile',{width:390,height:540}],['short-desktop',{width:1280,height:500}],['small-window',{width:820,height:500}],['landscape',{width:667,height:320}],['narrow',{width:320,height:480}]]){
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:'+server.address().port)
  await page.locator('[data-conversation-id="group"]').first().click();await page.locator('.bt-comm-title-pill').click()
  await page.getByRole('button',{name:'Choose receiving Bots',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Default receiving Bots',exact:true})
  assert.equal(await dialog.locator('[data-receiving-bot="bot:a:local"]').isChecked(),true)
  await dialog.locator('[data-receiving-bot="bot:b:remote"]').check()
  assert.match(await dialog.innerText(),/Buddy/)
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.endpoint==='save-settings').length),0)
  const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=viewport.width+1)
  assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1))
  await page.screenshot({path:join(output,'default-receivers-'+name+'.png'),animations:'disabled'})
  await dialog.getByRole('button',{name:'Use selected Bots',exact:true}).click()
  await page.waitForFunction(()=>window.fixture.calls.some(c=>c.endpoint==='save-settings'))
  const saved=await page.evaluate(()=>window.fixture.calls.find(c=>c.endpoint==='save-settings'))
  assert.deepEqual(saved.routing.defaultBotPrincipalIds,['bot:a:local','bot:b:remote'])
  assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.endpoint==='save-settings').length),1)
  assert.equal(await page.getByRole('button',{name:'Save group settings',exact:true}).count(),0)
  const body=page.locator('.bt-comm-members-body'),footer=page.locator('.bt-comm-members-footer')
  const footerBox=await footer.boundingBox()
  assert.ok(footerBox.y>=0&&footerBox.y+footerBox.height<=viewport.height+1,'fixed footer stays visible')
  assert.ok(await body.evaluate(node=>node.scrollHeight>node.clientHeight),'many members require scrolling')
  await body.evaluate(node=>{node.scrollTop=0})
  const bodyBox=await body.boundingBox()
  await page.mouse.move(bodyBox.x+bodyBox.width/2,bodyBox.y+bodyBox.height/2)
  await page.mouse.wheel(0,700)
  await page.waitForFunction(()=>document.querySelector('.bt-comm-members-body').scrollTop>0)
  const controls=page.locator('[data-principal-id="bot:b:extra-17"]')
  await controls.scrollIntoViewIfNeeded()
  await controls.getByRole('combobox',{name:'Speaking permission',exact:true}).selectOption('active')
  await page.waitForFunction(()=>window.fixture.snapshot.conversations[0].info.members.find(p=>p.principalId==='bot:b:extra-17').speakingMode==='active')
  for(const control of await controls.locator('select,button').all()){
   const box=await control.boundingBox()
   assert.ok(box.x>=0&&box.x+box.width<=viewport.width+1,'member controls fit horizontally')
   assert.ok(box.y>=bodyBox.y&&box.y+box.height<=footerBox.y+1,'scrolled member controls are visible')
  }
  assert.ok(await body.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'sidebar has no horizontal clipping')
  await page.screenshot({path:join(output,'member-autosave-'+name+'.png'),animations:'disabled'})
  assert.deepEqual(errors,[]);await page.close()
  console.log('PASS '+name+' separate receiving dialog, grouped multi-selection, no horizontal clipping, automatic save, scrolling member controls, pinned footer and zero browser errors')
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
