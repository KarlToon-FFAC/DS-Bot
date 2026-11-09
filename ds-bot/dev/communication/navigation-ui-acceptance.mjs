// Production React components and CSS, synthetic authorized state, no account data.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE ?? 'playwright')
const root=resolve(import.meta.dirname,'../..'),harness=join(root,'dev/harness/node_modules')
const output=resolve(process.argv[2]??join(root,'../.dsh-test-tools/navigation-ui'));mkdirSync(output,{recursive:true})
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {CommunicationSurface} from '${root}/src/client/communication.js';import {TeamSidebar,SIDEBAR_CSS} from '${root}/src/client/sidebar.js';
import {createSource} from '${root}/src/client/sources.js';import {SHELL_CSS} from '${root}/src/client/styles.js';import {communicationCSS} from '${root}/src/client/communication-styles.js';import {communicationDirectoryCSS} from '${root}/src/client/communication-directory-styles.js';
const style=document.createElement('style');style.textContent=SHELL_CSS+SIDEBAR_CSS+communicationCSS+communicationDirectoryCSS;document.head.append(style);
const self={principalId:'human:a:owner',kind:'human',displayName:'Alice',homeInstanceId:'a'};
const snapshot={enabled:true,hubId:'synthetic',connected:true,instanceId:'a',humanPrincipalId:self.principalId,managementRevision:1,contacts:[self],conversations:Array.from({length:40},(_,i)=>({conversationId:'g'+i,title:'Review group '+i,kind:'group',membershipEpoch:'e'+i,info:{members:[self]}})),invites:[],outbox:[],errors:[],compatibility:{clientVersion:'0.2.7',hubVersion:'0.2.8',status:'different'}};
const requests=[{requestId:'incoming',direction:'incoming',status:'pending',senderName:'Buddy',version:1},{requestId:'outgoing',direction:'outgoing',status:'pending',version:1}];const calls=[];
const request=async body=>{calls.push(body);switch(body.endpoint){case 'state':return structuredClone(snapshot);case 'contact-requests':return structuredClone(requests);case 'contact-relations':return [];case 'accept-contact':requests[0].status='accepted';snapshot.managementRevision++;return {};case 'cancel-contact':requests[1].status='cancelled';snapshot.managementRevision++;return {};case 'history':return {events:[]};default:return {}}};
const panel=createSource(true),team=createSource({communicationEnabled:true,communicationHubId:'synthetic',ready:true,bots:[]}),surface=createSource({mode:'bot'});
const reactRoot=createRoot(document.getElementById('root'));const remote=()=>reactRoot.render(React.createElement(CommunicationSurface,{roster:team,surface,panel,request}));
const roster={ready:true,bots:[],rooms:[],agents:[],byId:{}};let preference='open';
const local=()=>{panel.set(false);reactRoot.render(React.createElement(TeamSidebar,{wide:true,useRoster:pick=>pick(roster),useUi:pick=>pick({unread:{},leftDrawer:innerWidth<1024}),useRegistry:pick=>pick({}),useSessions:pick=>pick({ids:[],byId:{}}),useUpdate:()=>({}),useSidebarPref:pick=>pick(preference),actions:{openCommunication:()=>{panel.set(true);remote()},openPalette(){},openNewChat(){}}}))};
window.fixture={snapshot,requests,calls,remote,local,rail:()=>{preference='rail';local()}};remote();`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:root,loader:'js'},bundle:true,platform:'browser',format:'iife',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:"import React from 'react';export const FishLogo=()=>null;export const writeClipboard=()=>{};export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:root,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
try{
 browser=await chromium.launch({...(process.env.DSBOT_CHROMIUM_PATH?{executablePath:process.env.DSBOT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']})
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[]
 page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.locator('.bt-comm-request-badge').waitFor();assert.equal(await page.locator('.bt-comm-request-badge').innerText(),'2')
 async function remoteLayout(label){
  const before=await page.locator('.bt-comm-nav-footer').boundingBox();assert.ok(before.y>650)
  await page.locator('.bt-comm-nav-scroll').evaluate(node=>{node.scrollTop=node.scrollHeight})
  const after=await page.locator('.bt-comm-nav-footer').boundingBox();assert.equal(before.y,after.y)
  assert.ok(await page.getByRole('button',{name:'Back to local chats',exact:true}).isVisible())
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await page.screenshot({animations:'disabled',path:join(output,label+'.png')})
 }
 await remoteLayout('remote-navigation-pending-desktop')
 await page.setViewportSize({width:390,height:844});await remoteLayout('remote-navigation-pending-mobile')
 await page.getByRole('button',{name:'Contacts',exact:true}).click()
 await page.locator('.bt-comm-contact-section>summary').filter({hasText:'Contact requests'}).click()
 await page.getByRole('button',{name:'Accept contact',exact:true}).click()
 await page.waitForFunction(()=>document.querySelector('.bt-comm-request-badge')?.textContent==='1')
 await page.getByRole('button',{name:'Cancel request',exact:true}).click()
 await page.waitForFunction(()=>!document.querySelector('.bt-comm-request-badge'))
 await page.getByRole('button',{name:'Close dialog',exact:true}).click()
 await page.evaluate(()=>{Object.assign(window.fixture.snapshot,{connected:false,error:'UNSUPPORTED_CAPABILITY',compatibility:{clientVersion:'0.2.7',hubVersion:'0.2.8',status:'incompatible',updateTarget:'client'}});window.dispatchEvent(new Event('focus'))})
 await page.waitForFunction(()=>document.querySelector('.bt-comm-connection-label')?.textContent==='Client update required to connect')
 await page.locator('.bt-comm-nav-scroll').evaluate(node=>{node.scrollTop=0})
 await page.screenshot({animations:'disabled',path:join(output,'required-client-update-mobile.png')})
 await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>window.fixture.local())
 await page.locator('.bt-leftcol .bt-remote-entry').waitFor()
 async function localLayout(label){
  const button=page.getByRole('button',{name:'Remote communication',exact:true})
  await button.waitFor();const before=await button.boundingBox();assert.ok(before.y>650)
  await page.locator('.bt-list').evaluate(node=>{const filler=document.createElement('div');filler.style.minHeight='2000px';node.append(filler);node.scrollTop=node.scrollHeight})
  const after=await button.boundingBox();assert.equal(before.y,after.y)
  await page.screenshot({animations:'disabled',path:join(output,label+'.png')})
 }
 await localLayout('local-navigation-bottom-desktop')
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.fixture.local());await localLayout('local-navigation-bottom-mobile')
 await page.setViewportSize({width:1280,height:900});await page.evaluate(()=>window.fixture.rail());await localLayout('local-navigation-bottom-rail')
 assert.deepEqual(errors,[])
 console.log('PASS live pending badges and resolution; bottom navigation with long lists at desktop/mobile/rail; required-client-update reason; zero browser errors')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
