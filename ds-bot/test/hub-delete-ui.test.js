import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { managementPage, managementScript } from '../../communication-hub/src/management-ui.js'
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function fixture(t) {
 const dom = new JSDOM(managementPage, {url:'http://127.0.0.1:3190/admin/',runScripts:'outside-only'})
 t.after(() => dom.window.close())
 const {window} = dom, calls = []
 Object.defineProperty(window.document,'visibilityState',{value:'hidden'})
 let release, pending = false, failure
 const state = {requests:[],instances:[
  {instanceId:'device-a',label:'<Untrusted device>',trusted:1,pairingRevision:1,nameVersion:0,connected:false,ownedSharedGroups:[{conversationId:'shared-one',title:'<Shared group>',version:7}]},
  {instanceId:'device-b',label:'Unrelated device',trusted:0,revision:2,pairingRevision:2,nameVersion:0,connected:false,ownedSharedGroups:[]},
 ]}
 window.fetch = async (url,options) => {
  const action = url.split('/').at(-1), input = JSON.parse(options.body)
  if (action === 'session') return {ok:true,json:async()=>({ok:true,csrf:'synthetic'})}
  calls.push({action,input})
  if (action === 'delete') {
   if (pending) await new Promise(resolve=>{release=resolve})
   if (failure) return {ok:false,json:async()=>({ok:false,error:{code:failure}})}
   state.instances = state.instances.filter(i=>i.instanceId!==input.instanceId)
  }
  return {ok:true,json:async()=>({ok:true,value:state,revision:'synthetic'})}
 }
 window.AbortSignal=AbortSignal
 window.confirm=()=>assert.fail('complex device operations must use their own dialog')
 window.eval(managementScript)
 const render=()=>window.render(state); render()
 const open = async (id='device-a') => {
  window.document.querySelector('[data-instance-id="'+id+'"] button').click(); await tick()
 }
 const action = async name => {
  const b=[...window.document.querySelectorAll('#device-details button')].find(b=>b.textContent===name);assert.ok(b);b.click();await tick()
 }
 return {window,calls,state,render,open,action,defer:()=>{pending=true},release:()=>release(),fail:code=>{failure=code}}
}

test('compact device rows keep editing and deletion in separate dialogs with exact escaped impact and cancel without mutation',async t=>{
 const f=fixture(t),d=f.window.document
 assert.equal(d.querySelector('#instances input'),null)
 assert.equal(d.querySelectorAll('#instances article').length,2)
 assert.equal(d.querySelector('#device-dialog').open,false)
 await f.open(); await f.action('Delete device permanently')
 assert.equal(d.querySelector('#device-confirm').open,true)
 const body=d.querySelector('#device-confirm-body').textContent
 assert.match(body,/<Untrusted device>.*device-a/)
 assert.match(body,/This cannot be undone/)
 assert.match(body,/<Shared group>shared-one/)
 assert.match(body,/without assigning a new owner/)
 assert.equal(d.querySelector('untrusted'),null)
 d.querySelector('#device-confirm-cancel').click(); await tick()
 assert.equal(f.calls.some(c=>c.action==='delete'),false)
 assert.equal(d.querySelector('#device-confirm').open,false)
})

test('delete sends observed versions once and removes only the selected row after an acknowledged admin mutation',async t=>{
 const f=fixture(t),d=f.window.document;f.defer()
 await f.open(); await f.action('Delete device permanently')
 const submit=d.querySelector('#device-confirm-submit');submit.click();submit.click();await tick()
 assert.equal(f.calls.filter(c=>c.action==='delete').length,1)
 assert.equal(submit.disabled,true)
 assert.deepEqual(f.calls.find(c=>c.action==='delete').input,{instanceId:'device-a',expectedPairingRevision:1,expectedNameVersion:0,ownedSharedGroups:[{conversationId:'shared-one',version:7}],confirmDelete:true})
 f.release();for(let i=0;i<20&&d.querySelector('#device-confirm').open;i++)await tick()
 assert.equal(d.querySelectorAll('#instances article').length,1)
 assert.match(d.querySelector('#instances').textContent,/Unrelated device/)
 await f.open('device-b')
 assert.ok([...d.querySelectorAll('#device-details button')].some(b=>b.textContent==='Repair original device'))
})

test('same-name confirmations identify the exact instance and stale live impact disables confirmation before mutation',async t=>{
 const f=fixture(t),d=f.window.document
 for(const i of f.state.instances)i.label='Duplicate name';f.render()
 await f.open('device-b');await f.action('Delete device permanently')
 const body=d.querySelector('#device-confirm-body').textContent
 assert.match(body,/device-b/);assert.doesNotMatch(body,/device-a|shared-one/)
 f.state.instances[1].pairingRevision++;f.render()
 assert.equal(d.querySelector('#device-confirm-submit').disabled,true)
 assert.match(d.querySelector('#device-confirm-error').textContent,/changed/)
 d.querySelector('#device-confirm-submit').click();await tick()
 assert.equal(f.calls.some(c=>c.action==='delete'),false)
})

test('uncertain deletion keeps the device visible, displays its error in the dialog and cannot resend automatically',async t=>{
 const f=fixture(t),d=f.window.document;f.fail('REQUEST_FAILED')
 await f.open();await f.action('Delete device permanently')
 d.querySelector('#device-confirm-submit').click();for(let i=0;i<5;i++)await tick()
 assert.equal(d.querySelectorAll('#instances article').length,2)
 assert.match(d.querySelector('#device-confirm-error').textContent,/REQUEST_FAILED.*review current state/)
 assert.equal(d.querySelector('#device-confirm-submit').disabled,true)
 assert.equal(f.calls.filter(c=>c.action==='delete').length,1)
})

test('device search, status filter and bounded pages preserve details and render only 25 compact rows',async t=>{
 const f=fixture(t),d=f.window.document
 f.state.instances=Array.from({length:63},(_,n)=>({instanceId:'id-'+n,label:'Device '+n,trusted:n%2,connected:n%3===0,pairingRevision:1,nameVersion:0,ownedSharedGroups:[]}));f.render()
 assert.equal(d.querySelectorAll('#instances article').length,25)
 d.querySelector('#device-next').click();assert.match(d.querySelector('#device-page').textContent,/Page 2/)
 const search=d.querySelector('#device-search');search.value='id-62';search.dispatchEvent(new f.window.Event('input'))
 assert.equal(d.querySelectorAll('#instances article').length,1)
 assert.match(d.querySelector('#instances').textContent,/Device 62/)
 search.value='';search.dispatchEvent(new f.window.Event('input'))
 const filter=d.querySelector('#device-filter');filter.value='revoked';filter.dispatchEvent(new f.window.Event('change'))
 assert.match(d.querySelector('#device-count').textContent,/32 \/ 63/)
})

test('a live absence observation dismisses stale device deletion dialogs after a lost receipt or another administrator cleanup',async t=>{
 const f=fixture(t);await tick();await f.open();await f.action('Delete device permanently')
 assert.equal(f.window.document.querySelector('#device-confirm').open,true)
 f.state.instances=f.state.instances.filter(i=>i.instanceId!=='device-a');f.render()
 assert.equal(f.window.document.querySelector('#device-confirm').open,false)
 assert.equal(f.window.document.querySelector('#device-dialog').open,false)
 assert.match(f.window.document.querySelector('#error').textContent,/no longer exists/)
 assert.equal(f.calls.some(c=>c.action==='delete'),false)
})
