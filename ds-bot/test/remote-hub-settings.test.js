import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {runInNewContext} from 'node:vm'
import {build} from 'esbuild'
const harness=createRequire(join(process.env.DSH_HARNESS,'package.json'))
const {JSDOM}=harness('jsdom'),React=harness('react'),{act}=React
const {outputFiles}=await build({entryPoints:[fileURLToPath(new URL('../src/client/settings.js',import.meta.url))],bundle:true,platform:'browser',format:'cjs',external:['react','react-dom','@deepseek-ai/dsh-client-ui-primitives'],write:false})
async function view({enabled=true,readonly=false,reject=false}={},check){
 const dom=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:'http://127.0.0.1/',pretendToBeVisual:true}),doc=dom.window.document
 const saved=Object.fromEntries(['window','document','navigator','HTMLElement','IS_REACT_ACT_ENVIRONMENT'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]))
 for(const[key,value]of Object.entries({window:dom.window,document:doc,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,value})
 dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
 const module={exports:{}}
 runInNewContext(outputFiles[0].text,{module,exports:module.exports,require:id=>id==='react'?React:id==='react-dom'?harness('react-dom'):{MarkdownText:({text})=>React.createElement('p',null,text)},window:dom.window,document:doc,navigator:dom.window.navigator,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,setTimeout,clearTimeout,requestAnimationFrame:dom.window.requestAnimationFrame,cancelAnimationFrame:dom.window.cancelAnimationFrame,URL,AbortSignal,crypto:globalThis.crypto})
 const model={enabled,version:'preview-version',withdrawalPending:false},writes=[],closed=[]
 const actions={remoteHubSettings:async()=>({...model}),setRemoteHubEnabled:async input=>{
  writes.push(input)
  if(reject)throw Object.assign(Error('PRIVATE_EXCEPTION'),{code:'REMOTE_HUB_SETTINGS_CHANGED'})
  Object.assign(model,{enabled:input.enabled,version:'saved-version',withdrawalPending:!input.enabled,reloadRequired:true});return {...model}
 },folders:async()=>({team:null}),setPrefs:async()=>{},closeSettings:()=>closed.push(true),openSettings(){}}
 const roster={remoteHubEnabled:enabled,readOnly:readonly?'Other Host':null,prefs:{},bots:[],rooms:[],mainBotIds:[],byId:{},roomsById:{}}
 const root=harness('react-dom/client').createRoot(doc.getElementById('root'))
 const button=label=>[...doc.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===label||node.textContent===label)
 const click=async label=>{assert.ok(button(label),label);await act(async()=>button(label).click())}
 try{
  await act(async()=>root.render(React.createElement(module.exports.SettingsDialog,{page:'general',roster,actions})))
  await check({doc,dom,button,click,writes,model,closed})
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}
}

test('General settings enables the local Hub explicitly without a destructive confirmation',async()=>{
 await view({enabled:false},async({doc,button,click,writes})=>{
  assert.equal(button('Enable remote Hub').getAttribute('aria-checked'),'false')
  await click('Enable remote Hub')
  assert.equal(writes.length,1);assert.equal(writes[0].enabled,true);assert.equal(writes[0].expectedVersion,'preview-version')
  assert.equal(writes[0].confirmHideAllBots,undefined)
  assert.equal(doc.querySelector('[role=alertdialog]'),null)
  assert.equal(button('Enable remote Hub').getAttribute('aria-checked'),'true')
 })
})

test('disabling opens a separate warning and cancellation does not mutate the setting or publication',async()=>{
 await view({},async({doc,dom,button,click,writes,closed})=>{
  const trigger=button('Enable remote Hub');await act(async()=>trigger.focus())
  await click('Enable remote Hub')
  const dialog=doc.querySelector('dialog[role=alertdialog]');assert.ok(dialog)
  assert.match(dialog.textContent,/permanently end/);assert.match(dialog.textContent,/memberships and roles/)
  assert.match(dialog.textContent,/does not republish/);assert.match(dialog.textContent,/local Bots, files, chats/)
  assert.equal(writes.length,0);assert.equal(trigger.getAttribute('aria-checked'),'true')
  await act(async()=>{dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}))});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,200))})
  assert.equal(doc.querySelector('dialog'),null);assert.equal(writes.length,0);assert.equal(closed.length,0)
  assert.ok(doc.activeElement===trigger,'Focus returns to the Hub toggle')
 })
})

test('confirming disable sends the reviewed version and explicit hide consent, then shows pending withdrawal',async()=>{
 await view({},async({doc,button,click,writes})=>{
  await click('Enable remote Hub');await click('Hide all Bots and disable')
  assert.equal(writes.length,1)
  assert.equal(writes[0].enabled,false);assert.equal(writes[0].confirmHideAllBots,true);assert.equal(writes[0].expectedVersion,'preview-version')
  assert.equal(button('Enable remote Hub').getAttribute('aria-checked'),'false')
  assert.match(doc.querySelector('.bt-remote-hub-setting').textContent,/Hiding Bots on the Hub is pending/)
 })
})

test('a stale-setting denial preserves the enabled state and confirmation without replaying the write',async()=>{
 await view({reject:true},async({doc,button,click,writes})=>{
  await click('Enable remote Hub');await click('Hide all Bots and disable')
  assert.equal(writes.length,1);assert.equal(button('Enable remote Hub').getAttribute('aria-checked'),'true')
  assert.match(doc.querySelector('dialog [role=alert]').textContent,/changed elsewhere/)
  assert.doesNotMatch(doc.body.textContent,/PRIVATE_EXCEPTION/)
 })
})

test('read-only team cannot toggle remote Hub from General settings',async()=>{
 await view({readonly:true},async({button,click,writes})=>{
  assert.equal(button('Enable remote Hub').disabled,true);await click('Enable remote Hub');assert.equal(writes.length,0)
 })
})
