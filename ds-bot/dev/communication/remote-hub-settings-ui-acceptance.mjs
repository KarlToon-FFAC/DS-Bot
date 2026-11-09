// Production settings/sidebar components and CSS, with synthetic local-only state.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createServer} from 'node:http'
import {mkdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const root=resolve(import.meta.dirname,'../..'),harness=join(root,'dev/harness/node_modules')
const output=resolve(process.argv[2]??join(root,'../.dsh-test-tools/remote-hub-settings-ui'));mkdirSync(output,{recursive:true})
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {SettingsDialog} from '${root}/src/client/settings.js';import {TeamSidebar,SIDEBAR_CSS} from '${root}/src/client/sidebar.js';
import {SHELL_CSS} from '${root}/src/client/styles.js';import {communicationCSS} from '${root}/src/client/communication-styles.js';import {communicationDirectoryCSS} from '${root}/src/client/communication-directory-styles.js';
const style=document.createElement('style');style.textContent=SHELL_CSS+SIDEBAR_CSS+communicationCSS+communicationDirectoryCSS;document.head.append(style);
const roster={remoteHubEnabled:false,ready:true,bots:[],rooms:[],agents:[],byId:{},roomsById:{},mainBotIds:[],prefs:{}};
const state={enabled:false,version:'first',withdrawalPending:false},writes=[];const root=createRoot(document.getElementById('root'));
const actions={folders:async()=>({team:null}),setPrefs:async()=>{},closeSettings:()=>local(),openSettings:()=>settings(),remoteHubSettings:async()=>({...state}),setRemoteHubEnabled:async input=>{writes.push(input);Object.assign(state,{enabled:input.enabled,version:'next-'+writes.length,withdrawalPending:!input.enabled});roster.remoteHubEnabled=input.enabled;return {...state}},openCommunication(){},openPalette(){},openNewChat(){}};
const settings=()=>root.render(React.createElement(SettingsDialog,{page:'general',roster,actions}));
const local=()=>root.render(React.createElement(TeamSidebar,{wide:true,useRoster:pick=>pick(roster),useUi:pick=>pick({unread:{},leftDrawer:innerWidth<1024}),useRegistry:pick=>pick({}),useSessions:pick=>pick({ids:[],byId:{}}),useUpdate:()=>({}),useSidebarPref:pick=>pick('open'),actions}));
window.fixture={state,writes,settings,local};local();`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:root,loader:'js'},bundle:true,platform:'browser',format:'iife',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:"import React from 'react';export const FishLogo=()=>null;export const writeClipboard=()=>{};export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:root,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
try{
 browser=await chromium.launch({...(process.env.DSBOT_CHROMIUM_PATH?{executablePath:process.env.DSBOT_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']})
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message))
 for(const [label,width,height]of [['desktop',1280,900],['mobile',390,844]]){
  await page.setViewportSize({width,height});await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.locator('.bt-leftcol').waitFor();assert.equal(await page.locator('.bt-remote-entry').count(),0)
  await page.evaluate(()=>window.fixture.settings())
  const toggle=page.getByRole('switch',{name:'Enable remote Hub',exact:true});await toggle.waitFor()
  await page.screenshot({animations:'disabled',path:join(output,`${label}-default-off.png`)})
  await toggle.click();await page.waitForFunction(()=>window.fixture.writes.length===1)
  assert.equal(await page.locator('dialog').count(),0)
  await page.evaluate(()=>window.fixture.local());await page.locator('.bt-remote-entry').waitFor()
  await page.evaluate(()=>window.fixture.settings());await toggle.click()
  const dialog=page.getByRole('alertdialog',{name:'Disable remote Hub',exact:true});await dialog.waitFor()
  assert.equal(await page.evaluate(()=>window.fixture.writes.length),1)
  const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1)
  const confirm=dialog.getByRole('button',{name:'Hide all Bots and disable',exact:true});await confirm.scrollIntoViewIfNeeded();assert.ok(await confirm.isVisible())
  await page.screenshot({animations:'disabled',path:join(output,`${label}-disable-warning.png`)})
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'})
  assert.equal(await page.evaluate(()=>window.fixture.writes.length),1)
  await toggle.click();await dialog.waitFor();await confirm.click();await dialog.waitFor({state:'detached'})
  const last=await page.evaluate(()=>window.fixture.writes.at(-1));assert.equal(last.enabled,false);assert.equal(last.confirmHideAllBots,true)
  await page.getByRole('status').filter({hasText:'Hiding Bots on the Hub is pending'}).waitFor()
  await page.evaluate(()=>window.fixture.local());await page.locator('.bt-leftcol').waitFor();assert.equal(await page.locator('.bt-remote-entry').count(),0)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 }
 assert.deepEqual(errors,[]);console.log('PASS desktop/mobile General settings, default hidden entry, opt-in entry, separate warning, Escape cancel, explicit confirmation and pending state; zero browser errors')
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
