import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdirSync} from 'node:fs'
import {createServer} from 'node:http'
import {resolve,join} from 'node:path'
const {chromium}=await import(process.env.DSBOT_PLAYWRIGHT_MODULE??'playwright')
const root=resolve(import.meta.dirname,'../..'),client=join(root,'src/client'),harness=join(process.env.DSH_HARNESS??join(root,'dev/harness'),'node_modules')
const output=resolve(root,'../.dsh-test-tools/collapsed-group-contacts');mkdirSync(output,{recursive:true})
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {GroupBotChoices} from '${client}/communication-group.js';import {CommunicationActionDialog} from '${client}/communication-dialog.js';
import {SHELL_CSS} from '${client}/styles.js';import {communicationCSS} from '${client}/communication-styles.js';import {communicationDirectoryCSS} from '${client}/communication-directory-styles.js';import {themeCss,allThemes} from '${client}/themes.js';
const style=document.createElement('style');style.textContent=SHELL_CSS+communicationCSS+communicationDirectoryCSS+themeCss(allThemes().deepseek)+'body{margin:0;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}';document.head.append(style);
const human=(id,name)=>({principalId:'human:'+id+':owner',homeInstanceId:id,kind:'human',displayName:name,ipAddress:'192.0.2.20'});
const own=human('a','You'),buddy=human('b','Buddy'),lisa=human('c','Lisa');
const bot=(id,name)=>({principalId:'bot:'+id+':'+name,homeInstanceId:id,ownerPrincipalId:'human:'+id+':owner',kind:'bot',displayName:name,published:true});
const contacts=[own,buddy,lisa,bot('a','Local helper'),bot('b','Tester One'),bot('b','Tester Two'),bot('c','Designer')];
function App(){const [selected,onChange]=useState([]);return React.createElement(CommunicationActionDialog,{open:true,title:'New group',confirmLabel:'Create and invite',onClose(){},disabled:!selected.length,onConfirm:()=>{window.submitted=selected;return false}},React.createElement(GroupBotChoices,{contacts,humanId:own.principalId,instanceId:'a',selected,onChange,request:async()=>({})}));}
window.fixture={dark:()=>document.body.setAttribute('data-ds-dark-theme','')};createRoot(document.getElementById('root')).render(React.createElement(App));`
const {outputFiles}=await build({stdin:{contents:entry,resolveDir:client,loader:'js'},bundle:true,format:'iife',platform:'browser',write:false,alias:{react:harness+'/react','react-dom':harness+'/react-dom'},plugins:[{name:'synthetic-platform',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'primitives',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"import React from 'react';export const projectUserText=text=>text;export const FishLogo=()=>null;export const MarkdownText=({text})=>React.createElement('p',null,text);",resolveDir:client,loader:'js'}))}}]})
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?outputFiles[0].text:'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/app.js"></script></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser
try{
 browser=await chromium.launch({executablePath:process.env.DSBOT_CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox']})
 for(const [name,width] of [['desktop',1280],['mobile',390]]){
  const page=await browser.newPage({viewport:{width,height:850}}),errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:'+server.address().port);if(name==='mobile')await page.evaluate(()=>window.fixture.dark())
  const dialog=page.getByRole('dialog',{name:'New group',exact:true});await dialog.waitFor()
  const buddy=dialog.locator('[data-choice-contact-id="human:b:owner"]'),lisa=dialog.locator('[data-choice-contact-id="human:c:owner"]')
  assert.equal(await dialog.locator('details[open]').count(),0)
  assert.equal(await dialog.getByLabel('Invite Tester One',{exact:true}).isVisible(),false)
  assert.equal(await dialog.locator('summary input').count(),0)
  await page.screenshot({path:join(output,name+'-collapsed.png'),animations:'disabled'})
  await buddy.locator('summary').focus();await page.keyboard.press('Enter')
  await dialog.getByLabel('Invite Tester One',{exact:true}).check();await dialog.getByLabel('Invite Tester Two',{exact:true}).check()
  assert.equal(await lisa.getByLabel('Invite Designer',{exact:true}).isVisible(),false)
  await buddy.locator('summary').click()
  assert.ok((await buddy.locator('summary').textContent()).includes('Selected Bots: 2'))
  await lisa.locator('summary').click();await lisa.getByLabel('Invite Designer',{exact:true}).check()
  await buddy.locator('summary').click()
  assert.equal(await buddy.locator('input:checked').count(),2)
  await buddy.locator('summary').click();await lisa.locator('summary').click()
  await dialog.getByRole('button',{name:'Create and invite',exact:true}).click()
  assert.deepEqual(await page.evaluate(()=>window.submitted),['bot:b:Tester One','bot:b:Tester Two','bot:c:Designer'])
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.screenshot({path:join(output,name+'-selected-collapsed.png'),animations:'disabled'})
  assert.deepEqual(errors,[])
  console.log('PASS '+name+': contacts start collapsed; keyboard expansion, multi-contact selection and collapsed selected counts preserved')
  await page.close()
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
