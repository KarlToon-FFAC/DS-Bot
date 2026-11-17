import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdirSync} from 'node:fs'
import {createServer} from 'node:http'
import {resolve,join} from 'node:path'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const root=resolve(import.meta.dirname,'../..'),client=join(root,'src/client'),harness=join(process.env.DSH_HARNESS??join(root,'dev/harness'),'node_modules')
const output=resolve(root,'../.dsh-test-tools/conversation-management-ui');mkdirSync(output,{recursive:true})
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {CommunicationSurface} from '${client}/communication.js';import {createSource} from '${client}/sources.js';
import {SHELL_CSS} from '${client}/styles.js';import {themeCss,allThemes} from '${client}/themes.js';
import {communicationCSS} from '${client}/communication-styles.js';import {communicationDirectoryCSS} from '${client}/communication-directory-styles.js';
const style=document.createElement('style');style.textContent=SHELL_CSS+communicationCSS+communicationDirectoryCSS+themeCss(allThemes().deepseek)+'body{margin:0;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}';document.head.append(style);
const human={principalId:'human:a:owner',kind:'human',displayName:'Owner',role:'owner',speakingMode:'speak'};
const group=(id,title)=>({conversationId:id,title,kind:'group',role:'owner',speakingMode:'speak',membershipEpoch:'epoch',membershipVersion:1,joinSeq:1,watermark:1,cachedWatermark:1,info:{members:[human]}});
let snapshot={connected:true,instanceId:'a',humanPrincipalId:human.principalId,contacts:[human],conversationPreferencesScope:'scope',hiddenConversationIds:[],pinnedConversationIds:[],conversations:[group('first','First group'),group('second','Second group')],invites:[],outbox:[],errors:[]};
const request=async body=>{switch(body.endpoint){case 'state':return snapshot;case 'history':return {conversationId:body.conversationId,membershipEpoch:'epoch',events:[],watermark:1};case 'contact-requests':case 'contact-relations':return [];case 'set-conversation-hidden':snapshot={...snapshot,hiddenConversationIds:body.hidden?[body.conversationId]:[]};break;case 'set-conversation-pinned':snapshot={...snapshot,pinnedConversationIds:body.pinned?[body.conversationId]:[]};break;case 'delete-conversation':if(body.confirmed!==true)throw Error('No confirmation');snapshot={...snapshot,conversations:snapshot.conversations.filter(item=>item.conversationId!==body.conversationId)};return {status:'deleted'};default:return {}}
return {hiddenConversationIds:snapshot.hiddenConversationIds,pinnedConversationIds:snapshot.pinnedConversationIds};};
const panel=createSource(true);window.fixture={dark:()=>document.body.setAttribute('data-ds-dark-theme','')};
createRoot(document.getElementById('root')).render(React.createElement(CommunicationSurface,{roster:createSource({ready:true,communicationEnabled:true,remoteHubEnabled:true,bots:[]}),surface:createSource({mode:'bot'}),panel,request}));`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:client,loader:'js'},bundle:true,format:'iife',platform:'browser',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"import React from 'react';export const projectUserText=text=>text;export const FishLogo=()=>null;export const writeClipboard=()=>{};export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:client,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
try{
 browser=await chromium.launch({executablePath:process.env.DSBOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox']})
 for(const [name,width] of [['desktop',1280],['mobile',390]]){
  const page=await browser.newPage({viewport:{width,height:850}}),errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:'+server.address().port);if(name==='mobile')await page.evaluate(()=>window.fixture.dark())
  const row=id=>page.locator('nav[aria-label="Communication conversations"] [data-conversation-id="'+id+'"]')
  await row('second').click();await page.getByRole('button',{name:'Pin conversation',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('nav[aria-label="Communication conversations"] [data-conversation-id]')?.dataset.conversationId==='second')
  await page.getByRole('button',{name:'Hide conversation',exact:true}).click();await row('second').waitFor({state:'detached'})
  await page.getByRole('button',{name:'Hidden conversations',exact:true}).click()
  await page.getByRole('button',{name:'Show conversation Second group',exact:true}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click()
  // Leave enough time for the modal's intentional exit animation.
  await page.locator('.bt-comm-modal-backdrop').waitFor({state:'detached'}).catch(()=>{})
  if(name==='mobile'&&await page.getByRole('button',{name:'Conversations',exact:true}).isVisible())await page.getByRole('button',{name:'Conversations',exact:true}).click()
  await row('second').click();await page.getByRole('button',{name:'Delete conversation',exact:true}).click()
  const dialog=page.getByRole('alertdialog',{name:'Delete conversation',exact:true});await dialog.waitFor()
  const confirm=dialog.getByRole('button',{name:'Delete chat history',exact:true}),bounds=await confirm.boundingBox()
  assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.y+bounds.height<=850,'confirmation stays inside viewport')
  assert.ok((await dialog.textContent()).includes('It cannot be restored.'))
  await page.screenshot({path:join(output,name+'-delete-confirmation.png'),fullPage:true})
  await confirm.click();await row('second').waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow')
  assert.deepEqual(errors,[])
  console.log('PASS '+name+': pin, group hide/show, visible deletion confirmation and successful removal')
  await page.close()
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
