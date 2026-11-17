import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdirSync} from 'node:fs'
import {createServer} from 'node:http'
import {resolve,join} from 'node:path'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const root=resolve(import.meta.dirname,'../..'),client=join(root,'src/client'),harness=join(process.env.DSH_HARNESS??join(root,'dev/harness'),'node_modules')
const output=resolve(root,'../.dsh-test-tools/local-exchanges-ui');mkdirSync(output,{recursive:true})
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ExchangeDialog} from '${client}/exchange.js';import {TriggerCell,ToolCell} from '${client}/cells.js';import {SHELL_CSS,CONVERSATION_CSS} from '${client}/styles.js';import {themeCss,allThemes} from '${client}/themes.js';
const style=document.createElement('style');style.textContent=SHELL_CSS+CONVERSATION_CSS+themeCss(allThemes().deepseek)+'body{margin:0;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}main{padding:24px;margin-left:240px}.fixture-sidebar{position:fixed;left:0;top:0;bottom:0;width:240px}@media(max-width:600px){.fixture-sidebar{width:48px}main{margin-left:48px}}';document.head.append(style);
const chief={id:'chief',name:'Local Chief',color:'green'},worker={id:'worker',name:'Remote worker',color:'blue'};
const roster={bots:[chief,worker],byId:{chief,worker},rooms:[],roomsById:{},prefs:{},exchangeTurns:{chief:[1]},remoteExchangeTurns:{chief:[1]},localConsultations:[{id:'consult',ownerBotId:'worker',targetBotId:'chief',status:'completed'}]};
const origin={conversationId:'remote-room',messageId:'remote-source'},long='COMPLETE_SAVED_RESULT '+('Synthetic internal consultation answer. '.repeat(130))+' FINAL_SAVED_END';
const entries=[{id:'consult',from:'worker',to:'chief',text:'Please review this remote task.',time:1000,remoteSource:origin},{id:'consultation-result:consult',from:'chief',to:'worker',text:long.slice(0,300),length:long.length,time:2000,remoteSource:origin,consultationResult:true}];
function App(){const [pair,setPair]=useState(null);const actions={openExchange:(a,b)=>setPair([a,b]),closeOverlay:()=>setPair(null),exchange:async()=>entries,exchangeText:async()=>({text:long,whole:true}),noteTurnPeer(){},noteLive(){},noteCards(){}};
return React.createElement(React.Fragment,null,React.createElement('main',null,React.createElement('h2',null,'Local Chief chat'),React.createElement(TriggerCell,{node:{key:'source',location:{turn:{turn:1}},data:{seq:1,source:{kind:'bot',role:'federation-report',senderSessionId:'worker',remoteSource:origin}}},sessionId:'chief',actions,useRoster:select=>select(roster),useSessions:select=>select({byId:{}}),useTurnClock:select=>select({}),useUi:select=>select({visits:{}})}),React.createElement(ToolCell,{node:{location:{turn:{turn:1}},data:{root:{kind:'tool-result',name:'reply_to_local_consultation',callId:'reply',call:{name:'reply_to_local_consultation',argsRaw:JSON.stringify({consultationId:'consult',text:'PRIVATE_TOOL_ARGUMENT'})},content:[{type:'text',text:'PRIVATE_TOOL_RESULT'}]}}},sessionId:'chief',actions,useRoster:select=>select(roster),useUi:select=>select({}),useHeldCards:()=>({})})),pair?React.createElement(ExchangeDialog,{pair,roster,actions}):null)}
window.fixture={dark:()=>document.body.setAttribute('data-ds-dark-theme','')};createRoot(document.getElementById('root')).render(React.createElement(App));`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:client,loader:'js'},bundle:true,format:'iife',platform:'browser',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"import React from 'react';export const projectUserText=text=>text;export const writeClipboard=()=>{};export const FishLogo=()=>null;export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:client,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><aside class="fixture-sidebar"><div class="_footArea"></div></aside><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
try{
 browser=await chromium.launch({executablePath:process.env.DSBOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox']})
 for(const [name,width] of [['desktop',1280],['mobile',390]]){
  const page=await browser.newPage({viewport:{width,height:850}}),errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:'+server.address().port);if(name==='mobile')await page.evaluate(()=>window.fixture.dark())
  assert.equal(await page.locator('main').innerText().then(text=>text.includes('PRIVATE_')),false)
  await page.locator('.bt-event-whole').first().click()
  const dialog=page.getByRole('dialog',{name:'Bot exchange',exact:true});await dialog.waitFor()
  await page.getByText('Please review this remote task.',{exact:true}).waitFor()
  assert.equal(await dialog.locator('.bt-exchange-origin').count(),2)
  assert.ok((await dialog.innerText()).includes('Remote task · consultation result'))
  await page.locator('.bt-exchange').evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).filter(animation=>animation.effect.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))})
  await page.screenshot({path:join(output,name+'-exchange.png'),fullPage:true})
  await dialog.getByRole('button',{name:/Show all/}).click()
  await page.waitForFunction(()=>document.querySelector('.bt-dialog-log')?.innerText.includes('FINAL_SAVED_END'))
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.getByRole('button',{name:'Close Chat',exact:true}).click();await dialog.waitFor({state:'detached'})
  await page.locator('.bt-event-whole').last().click();await dialog.waitFor()
  assert.ok((await dialog.innerText()).includes('COMPLETE_SAVED_RESULT'))
  assert.equal(await page.locator('body').innerText().then(text=>text.includes('PRIVATE_')),false)
  assert.deepEqual(errors,[])
  console.log('PASS '+name+': incoming report and reply tool open the same native exchange; saved result and origin shown without private tool text')
  await page.close()
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
