import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createSource } from '../src/client/sources.js'

const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = harness('jsdom'), React = harness('react'), { act } = React
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/client/communication.js', import.meta.url))],
  bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false })

async function pane({ enabled = true, snapshot, storage = {}, localStored = {}, history = [], getState, handleRead = async () => ({}), MarkdownText = ({ text }) => React.createElement('p', null, text), handle = async () => ({}), cryptoSource = { subtle: globalThis.crypto.subtle, getRandomValues: bytes => globalThis.crypto.getRandomValues(bytes) } }, check) {
  const dom = new JSDOM('<!doctype html><body><textarea id="native">private draft</textarea><div id="root"></div></body>', { url: 'http://127.0.0.1:3138/', pretendToBeVisual: true })
  for (const [key, value] of Object.entries(storage)) dom.window.sessionStorage.setItem(key, value)
  for (const [key, value] of Object.entries(localStored)) dom.window.localStorage.setItem(key, value)
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const { createRoot } = harness('react-dom/client')
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports,
    require: id => id === 'react' ? React : id === 'react-dom' ? harness('react-dom') : { MarkdownText },
    window: dom.window, document: dom.window.document, navigator:dom.window.navigator, sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage,
    setTimeout, clearTimeout, crypto: cryptoSource, URL, AbortSignal, requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame })
  const panel = createSource(true), roster = createSource({ communicationEnabled: enabled }), surface = createSource({ mode: 'bot' }), calls = []
  const request = async body => {
    calls.push(body)
    if (body.endpoint === 'state') return getState ? getState() : { ...snapshot, conversations: snapshot.conversations?.map(item => ({ ...item })) }
    if (body.endpoint === 'history') { const value = typeof history === 'function' ? await history(body) : history; return Array.isArray(value) ? { conversationId: body.conversationId, membershipEpoch: 'epoch', events: value } : value }
    if (body.endpoint === 'read') return handleRead(body)
    return handle(body)
  }
  let root = createRoot(dom.window.document.getElementById('root'))
  const doc = dom.window.document
  const button = label => [...doc.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  const click = async label => {
    if (!button(label) && ['New group','New message'].includes(label)) await act(async()=>button('New…').click())
    assert.ok(button(label), `button: ${label}`); await act(async () => button(label).click())
  }
  const autoRefresh = async () => act(async () => { dom.window.dispatchEvent(new dom.window.Event('focus')); await new Promise(resolve => setTimeout(resolve, 600)) })
  const edit = async (node, value) => {
    await act(async () => {
      const type = node.tagName === 'SELECT' ? dom.window.HTMLSelectElement : node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement
      Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(node, value)
      node.dispatchEvent(new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
  }
  try {
    await act(async () => root.render(React.createElement(mod.exports.CommunicationSurface, { roster, surface, panel, request })))
    await check({ dom, doc, panel, surface, calls, button, click, edit, autoRefresh, remount: async () => {
      await act(async () => root.unmount())
      root = createRoot(dom.window.document.getElementById('root'))
      await act(async () => root.render(React.createElement(mod.exports.CommunicationSurface, { roster, surface, panel, request })))
    } })
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

const membership = { conversationId: 'group', title: 'Shared group', kind: 'group', role: 'owner', speakingMode: 'speak', membershipEpoch: 'epoch', membershipVersion: 1,
  ownerPrincipalId: 'human:a:owner', joinSeq: 1, watermark: 1, info: { members: [{ principalId: 'human:a:owner', displayName: 'Owner', kind: 'human', role: 'owner', speakingMode: 'speak' }] } }
const state = () => ({ connected: true, instanceId: 'a', humanPrincipalId: 'human:a:owner', contacts: [], conversations: [], invites: [], outbox: [], errors: [] })

test('a departed device can reconcile administrator repair without reconnecting and forgetting names the exact cleanup scope',async()=>{
 let departed=true, repaired=false
 const hub={hubId:'saved-hub',url:'wss://synthetic.example.test/communication',status:'approved',paused:true,requestId:'saved-request',instanceId:'saved-instance'}
 await pane({snapshot:state(),handle:async body=>{
  if(body.endpoint==='onboarding-storage')return {selectedHub:{hubId:hub.hubId,url:hub.url,enabled:false},enrollments:[{...hub,departed}]}
  if(body.endpoint==='hub-leave-status'){if(repaired)departed=false;return {hubId:hub.hubId,left:departed}}
  return {}
 }},async({ autoRefresh,doc,click,calls,button})=>{
  await click('Personal settings');await click('Join Hub')
  assert.equal(button('Check revoked access'),undefined)
  assert.equal(button('Resume this Hub'),undefined)
  repaired=true;await autoRefresh()
  assert.ok(button('Resume this Hub'))
  assert.equal(calls.some(call=>['resume-hub','join-hub','switch-hub'].includes(call.endpoint)),false)
  await click('Forget this Hub')
  const confirmation=doc.querySelector('[role=alertdialog]')
  assert.match(confirmation.textContent,/communication queue and cached files/)
  assert.match(confirmation.textContent,/DSH session journals and browser drafts are retained/)
  assert.equal(confirmation.querySelector('input[type=checkbox]').checked,false,'history/cache removal requires a separate explicit choice')
  assert.equal(calls.some(call=>call.endpoint==='forget-hub'),false)
 })
})

test('picked files can be sent without text using one stable request and clear only after acknowledgement',async()=>{
 const snapshot={...state(),attachmentsAvailable:true,conversations:[membership]}
 await pane({snapshot},async({dom,doc,click,calls,button})=>{
  await click('Shared group')
  const picker=doc.querySelector('input[type=file]');assert.ok(picker)
  Object.defineProperty(picker,'files',{configurable:true,value:[{name:'合成文档.txt',type:'text/plain',size:4,arrayBuffer:async()=>new Uint8Array([116,101,115,116]).buffer}]})
  await act(async()=>{picker.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,25))})
  assert.match(doc.querySelector('.bt-comm-attachment-drafts').textContent,/合成文档/)
  assert.equal(button('Send message').disabled,false)
  await click('Send message')
  const sends=calls.filter(call=>call.endpoint==='send');assert.equal(sends.length,1)
  assert.equal(sends[0].text,'');assert.equal(sends[0].attachments[0].data,'dGVzdA==')
  assert.equal(sends[0].attachments[0].sha256,'9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
  assert.equal(doc.querySelector('.bt-comm-attachment-drafts'),null)
 })
})

test('oversized or unsupported attachments show non-chat feedback; readonly members have no picker',async()=>{
 await pane({snapshot:{...state(),attachmentsAvailable:true,conversations:[membership]}},async({dom,doc,click,calls})=>{
  await click('Shared group')
  const picker=doc.querySelector('input[type=file]')
  Object.defineProperty(picker,'files',{value:[{name:'too-large.bin',size:65537}]})
  await act(async()=>{picker.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,0))})
  assert.match(doc.querySelector('.bt-comm-toast').textContent,/64 KiB/)
  assert.equal(doc.querySelector('.bt-comm-log article'),null)
  assert.equal(calls.some(call=>call.endpoint==='send'),false)
 })
 await pane({snapshot:{...state(),attachmentsAvailable:true,conversations:[{...membership,role:'member',speakingMode:'readOnly'}]}},async({doc,click})=>{
  await click('Shared group');assert.equal(doc.querySelector('input[type=file]'),null)
 })
})

test('remote file paste and drop stay in this composer without bubbling into local chat or auto-sending',async()=>{
 for(const kind of ['paste','drop'])await pane({snapshot:{...state(),attachmentsAvailable:true,conversations:[membership]}},async({dom,doc,click,calls})=>{
  await click('Shared group')
  let escaped=0
  doc.addEventListener(kind,()=>escaped++)
  const event=new dom.window.Event(kind,{bubbles:true,cancelable:true})
  Object.defineProperty(event,kind==='paste'?'clipboardData':'dataTransfer',{value:{files:[{name:kind+'.txt',type:'text/plain',size:4,arrayBuffer:async()=>new Uint8Array([116,101,115,116]).buffer}]}})
  await act(async()=>{doc.querySelector('textarea[aria-label="Communication message"]').dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,25))})
  assert.equal(event.defaultPrevented,true)
  assert.equal(escaped,0,'remote file event must not reach local chat upload handlers')
  assert.match(doc.querySelector('.bt-comm-attachment-drafts').textContent,new RegExp(kind+'\\.txt'))
  assert.equal(doc.getElementById('native').value,'private draft')
  assert.equal(calls.some(body=>body.endpoint==='send'),false)
 })
})

test('switching Hubs with colliding conversation identity cannot display old history or reuse its draft',async()=>{
 let snapshot={...state(),hubId:'hub-a',queueScope:'hub-a',conversations:[membership]},release
 const event={type:'message',conversationSeq:1,serverAcceptedAt:'2026-11-04T00:00:00Z',message:{messageId:'old',author:membership.info.members[0],content:{text:'Only Hub A secret'},mentions:[]}}
 await pane({getState:()=>snapshot,history:()=>snapshot.hubId==='hub-a'?[event]:new Promise(resolve=>{release=resolve})},async({ autoRefresh,doc,click,edit})=>{
  await click('Shared group');assert.match(doc.querySelector('.bt-comm-log').textContent,/Only Hub A/)
  await edit(doc.querySelector('textarea[aria-label="Communication message"]'),'Hub A private draft')
  snapshot={...snapshot,hubId:'hub-b',queueScope:'hub-b'}
  await autoRefresh()
  assert.doesNotMatch(doc.querySelector('.bt-comm-log').textContent,/Only Hub A/)
  assert.equal(doc.querySelector('textarea[aria-label="Communication message"]').value,'')
  await act(async()=>release([]))
  snapshot={...snapshot,hubId:'hub-a',queueScope:'hub-a'};await autoRefresh()
  assert.equal(doc.querySelector('textarea[aria-label="Communication message"]').value,'Hub A private draft')
 })
})

test('native-style title opens member details and returns keyboard focus without losing permission checks', async () => {
  await pane({ snapshot: { ...state(), conversations: [membership] } }, async ({ doc, click, calls }) => {
    await click('Shared group')
    const pill = doc.querySelector('.bt-comm-title-pill')
    assert.ok(pill.querySelector('.bt-comm-room-avatar'))
    assert.equal(doc.querySelector('.bt-comm-members').open, false)
    await act(async () => pill.click())
    assert.equal(doc.querySelector('.bt-comm-members').open, true)
    assert.ok(doc.querySelector('input[aria-label="Group name"]'))
    await click('Close member settings')
    assert.equal(doc.activeElement, pill)
    assert.equal(doc.querySelector('.bt-comm-members>summary').tabIndex, -1)
    assert.equal(calls.some(call => call.endpoint === 'save-settings'), false)
    assert.ok(doc.querySelector('footer textarea[aria-label="Communication message"]'))
    assert.equal(doc.querySelector('footer>button').getAttribute('aria-label'), 'Send message')
  })
})

test('signed Hub review confirms exact scoped fingerprint and trust update never submits enrollment', async () => {
  const hub = { version: 2, hubId: 'hub-review', url: 'wss://hub.example.test/communication', trustFingerprint: 'a'.repeat(64) }
  const saved = { ...hub, status: 'approved', requestId: 'existing', instanceId: 'a' }
  await pane({ enabled: false, handle: async body => {
    if (body.endpoint === 'onboarding-storage') return { storage: { kind: 'test' }, enrollments: [saved] }
    if (body.endpoint === 'decode-hub-code') return hub
    if (body.endpoint === 'update-hub-trust') { assert.equal(body.confirmedTrustFingerprint, hub.trustFingerprint); assert.equal(body.confirmedHubId, hub.hubId); assert.equal(body.confirmedUrl, hub.url); return saved }
    assert.fail(`Unexpected endpoint ${body.endpoint}`)
  } }, async ({ doc, click, edit, calls }) => {
    await click('Personal settings'); await click('Join Hub')
    await edit(doc.querySelector('textarea[aria-label="Hub code"]'), 'synthetic-v2-code')
    await click('Review Hub')
    assert.match(doc.querySelector('.bt-comm-onboarding').textContent, /trusted channel/)
    assert.match(doc.querySelector('.bt-comm-onboarding').textContent, new RegExp(hub.trustFingerprint))
    await click('Update this Hub CA trust')
    assert.equal(calls.filter(call => call.endpoint === 'update-hub-trust').length, 1)
    assert.equal(calls.some(call => call.endpoint === 'join-hub'), false)
    assert.equal(doc.querySelector('a.bt-comm-admin-link'), null)
  })
})

test('a host modal above restored remote communication does not compete for focus or consume Escape', async () => {
  await pane({ snapshot: state() }, async ({ doc, dom, panel }) => {
    const dialog=doc.createElement('section'),button=doc.createElement('button')
    dialog.setAttribute('role','dialog');button.textContent='Host first-run';dialog.append(button);doc.body.append(dialog)
    await act(async()=>button.focus())
    assert.equal(doc.activeElement===button,true,'host modal keeps focus without a recursive trap')
    await act(async()=>button.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    assert.equal(panel.getSnapshot(),true,'host Escape does not close the underlying remote window')
    dialog.remove()
  })
})

test('native toolbar creation submenu supports both actions, keyboard, outside dismissal and return focus', async () => {
  await pane({snapshot:state()},async({doc,dom,panel,click})=>{
    assert.deepEqual([...doc.querySelectorAll('.bt-comm-nav-actions button')].map(node=>node.getAttribute('aria-label')),['Personal settings','Contacts','Search','New…','Collapse sidebar'])
    assert.equal(doc.querySelector('[role=menuitem]'),null)
    await click('New…')
    const items=[...doc.querySelectorAll('[role=menuitem]')]
    assert.deepEqual(items.map(node=>node.textContent),['New message','New group'])
    assert.equal(doc.activeElement===items[0],true)
    await act(async()=>items[0].dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})))
    assert.equal(doc.activeElement===items[1],true)
    await act(async()=>items[1].dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    assert.equal(doc.querySelector('[role=menuitem]'),null);assert.equal(panel.getSnapshot(),true)
    assert.equal(doc.activeElement.getAttribute('aria-label'),'New…')
    for(const [action,label] of [['New message','New message'],['New group','New group']]){
      await click(action);assert.ok(doc.querySelector(`.bt-comm-modal[aria-label="${label}"]`));await click('Cancel')
    }
    await click('New…');await act(async()=>doc.querySelector('main').dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true})))
    assert.equal(doc.querySelector('[role=menuitem]'),null)
  })
})

test('sidebar restores across empty/chat/narrow navigation and scoped search preserves drafts without sending',async()=>{
  const snapshot={...state(),conversations:[membership,{...membership,conversationId:'hidden',title:'Previously closed group'}]}
  const storage={'ds-bot:communication:hidden':JSON.stringify(['a:hidden'])}
  await pane({snapshot,storage},async({doc,dom,click,edit,calls,remount})=>{
    await click('Collapse sidebar');assert.equal(doc.querySelector('.bt-comm-frame').dataset.collapsed,'true')
    assert.equal(doc.activeElement.getAttribute('aria-label'),'Expand sidebar')
    await remount();assert.equal(doc.querySelector('.bt-comm-frame').dataset.collapsed,'true')
    await click('Expand sidebar');assert.equal(doc.querySelector('.bt-comm-frame').dataset.collapsed,'false')
    assert.ok(doc.querySelector('nav button[data-conversation-id=hidden]'))
    await click('Shared group');await edit(doc.querySelector('textarea[aria-label="Communication message"]'),'Keep this draft')
    await click('Collapse sidebar')
    await act(async()=>doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})))
    assert.ok(doc.querySelector('.bt-comm-modal[aria-label="Search"]'))
    assert.match(doc.querySelector('.bt-comm-search').textContent,/Previously closed group/)
    const search=doc.querySelector('input[aria-label="Search conversations and contacts"]')
    await edit(search,'no-match');await act(async()=>{for(const key of ['End','Enter'])search.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true}))})
    assert.match(doc.querySelector('.bt-comm-search').textContent,/No matching/)
    await edit(search,'Shared');await act(async()=>search.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
    assert.equal(doc.querySelector('.bt-comm-modal'),null)
    assert.equal(doc.querySelector('textarea[aria-label="Communication message"]').value,'Keep this draft')
    assert.equal(calls.some(call=>['send','create-group','dm'].includes(call.endpoint)),false)
    await click('Conversations');assert.equal(doc.querySelector('.bt-comm-frame').dataset.collapsed,'false')
    assert.equal(doc.querySelector('.bt-comm-frame').dataset.browse,'true')
  })
})

for (const hiddenValue of [JSON.stringify(['a:group', 'a:dm', 'hub-one:a:group', 'hub-two:a:group', 'a:departed']), '{invalid', JSON.stringify({ group: true })]) {
  test(`all authorized groups and DMs ignore legacy close state without deleting saved data (${hiddenValue})`, async () => {
    const dm = { ...membership, conversationId: 'dm', kind: 'dm', title: 'Direct conversation' }
    const snapshot = { ...state(), conversations: [membership, dm] }
    const draft = JSON.stringify({ 'a:group': { text: 'Keep my saved draft', mentions: [] }, 'other:private': { text: 'Other Hub draft', mentions: [] } })
    const attempts = JSON.stringify({ 'other:private': { endpoint: 'send', messageId: 'original-unsent-id', text: 'Keep original intent' } })
    const storage = { 'ds-bot:communication:hidden': hiddenValue, 'ds-bot:communication:drafts': draft, 'ds-bot:communication:attempts': attempts }
    await pane({ snapshot, storage }, async ({ autoRefresh, doc, dom, click, edit, remount, calls }) => {
      const ids = () => [...doc.querySelectorAll('nav [data-conversation-id]')].map(node => node.dataset.conversationId)
      assert.deepEqual(ids(), ['group', 'dm'])
      assert.equal(doc.querySelector('.bt-comm-section-title span').textContent, '2')
      await click('Shared group')
      assert.equal(doc.querySelector('textarea[aria-label="Communication message"]').value, 'Keep my saved draft')
      assert.equal(doc.querySelector('button[aria-label="Close on this device"]'), null)
      await act(async () => doc.querySelector('nav [data-conversation-id=dm]').click())
      assert.equal(doc.querySelector('button[aria-label="Close on this device"]'), null)
      await click('Search')
      await edit(doc.querySelector('input[aria-label="Search conversations and contacts"]'), 'Shared')
      await act(async () => doc.querySelector('input[aria-label="Search conversations and contacts"]').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      assert.equal(doc.querySelector('textarea[aria-label="Communication message"]').value, 'Keep my saved draft')
      await remount()
      assert.deepEqual(ids(), ['group', 'dm'])
      assert.equal(doc.querySelector('textarea[aria-label="Communication message"]').value, 'Keep my saved draft')
      for (const [key, value] of Object.entries(storage)) assert.equal(dom.window.sessionStorage.getItem(key), value, key)
      assert.equal(calls.some(call => !['state', 'history', 'read', 'avatar'].includes(call.endpoint)), false, 'restoration performs no membership or message mutation')
      snapshot.hubId = 'hub-one'; snapshot.queueScope = 'isolated'
      snapshot.conversations = [{ ...membership, title: 'Current Hub group' }]
      await autoRefresh()
      assert.deepEqual(ids(), ['group'])
      assert.equal(doc.querySelector('nav [data-conversation-id=group]').textContent, 'Current Hub group')
      snapshot.hubId = 'hub-two'; snapshot.conversations = []
      await autoRefresh()
      assert.deepEqual(ids(), [], 'legacy close records cannot fabricate membership after authorization or Hub changes')
      assert.match(doc.querySelector('.bt-comm-empty').textContent, /Start a conversation/)
      for (const [key, value] of Object.entries(storage)) assert.equal(dom.window.sessionStorage.getItem(key), value, key)
    })
  })
}

test('uncertain enrollment restores its saved request, exposes safe diagnostics and never automatically resubmits', async () => {
  const hub = { hubId: 'onboarding-test', url: 'wss://hub.example.test/communication' }, storage = { defaultProvider: 'test', encryptedByDefault: false }
  let saved = null, absent = false
  await pane({ enabled: false, handle: async body => {
    if (body.endpoint === 'onboarding-storage') return saved ? { configured: true, storage, ...saved } : { configured: false, storage, enrollments: [] }
    if (body.endpoint === 'decode-hub-code') return hub
    if (body.endpoint === 'join-hub') { saved = { ...hub, requestId: 'same-request', status: 'prepared' }; throw Object.assign(new Error('DO_NOT_DISPLAY_RAW_FAILURE'), { code: 'CONNECTION_LOST', phase: 'ENROLLMENT_PROOF_FAILED' }) }
    if (body.endpoint === 'hub-join-status') { if (absent) throw Object.assign(new Error('not found'), { code: 'JOIN_NOT_FOUND' }); saved.status = 'pending'; return saved }
    assert.fail('Unexpected endpoint')
  } }, async ({ autoRefresh, doc, click, edit, calls, button }) => {
    await click('Personal settings'); await click('Join Hub')
    await edit(doc.querySelector('[aria-label="Hub code"]'), 'synthetic-public-hub-code'); await click('Review Hub')
    assert.match(doc.querySelector('.bt-comm-onboarding').textContent, /does not test network access or submit/)
    await click('Confirm and request access')
    assert.match(doc.querySelector('.bt-comm-onboarding').textContent, /same-request/)
    assert.match(doc.querySelector('.bt-comm-error').textContent, /CONNECTION_LOST.*ENROLLMENT_PROOF_FAILED/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-error').textContent, /DO_NOT_DISPLAY_RAW_FAILURE/)
    assert.equal(button('Confirm and request access').disabled, true)
    assert.equal(calls.filter(call => call.endpoint === 'hub-join-status').length, 0)
    await autoRefresh()
    assert.equal(calls.filter(call => call.endpoint === 'join-hub').length, 1)
    assert.match(doc.querySelector('.bt-comm-onboarding').textContent, /pending/)
    absent = true; await autoRefresh()
    assert.equal(button('Confirm and request access').disabled, false, 'explicit not-found status permits an explicit retry')
    assert.equal(calls.filter(call => call.endpoint === 'join-hub').length, 1)
  })
})

test('an unreadable local request after an ambiguous join keeps submission blocked until local status is recovered', async () => {
  const storage = { defaultProvider: 'test' }, hub = { hubId: 'unreadable-test', url: 'wss://hub.example.test/communication' }
  let reads = 0
  await pane({ enabled: false, handle: async body => {
    if (body.endpoint === 'onboarding-storage') { reads++; if (reads === 2) throw Error('DO_NOT_DISPLAY_LOCAL_FAILURE'); return { configured: false, storage, enrollments: [] } }
    if (body.endpoint === 'decode-hub-code') return hub
    if (body.endpoint === 'join-hub') throw Object.assign(new Error('DO_NOT_DISPLAY_JOIN_FAILURE'), { phase: 'COMMUNICATION_CREDENTIAL_WRITE_FAILED' })
    assert.fail('Unexpected endpoint')
  } }, async ({ autoRefresh, doc, click, edit, button, calls }) => {
    await click('Personal settings'); await click('Join Hub')
    await edit(doc.querySelector('[aria-label="Hub code"]'), 'synthetic-public-hub-code'); await click('Review Hub'); await click('Confirm and request access')
    assert.match(doc.querySelector('.bt-comm-error').textContent, /COMMUNICATION_CREDENTIAL_WRITE_FAILED/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-error').textContent, /DO_NOT_DISPLAY/)
    assert.equal(button('Confirm and request access').disabled, true)
    await autoRefresh()
    assert.equal(button('Confirm and request access').disabled, false)
    assert.equal(calls.filter(call => call.endpoint === 'join-hub').length, 1)
  })
})

test('personal gear owns profile, identity and connection settings without conversation visibility controls', async () => {
  const snapshot = { ...state(), conversations: [membership] }
  await pane({ snapshot }, async ({ doc, click, edit, calls }) => {
    assert.equal(doc.querySelectorAll('.bt-comm-nav-heading button[aria-label="Personal settings"]').length, 1)
    assert.doesNotMatch(doc.querySelector('.bt-comm-nav').textContent, /Human profile|Show closed conversations|Add a device|Manage contacts/)
    await click('Personal settings')
    const modal = doc.querySelector('.bt-comm-personal-settings')
    assert.match(modal.textContent, /Your profile.*Device identity.*Hub connection/s)
    assert.doesNotMatch(modal.textContent, /Show closed conversations|Hide closed conversations/)
    await edit(modal.querySelector('input[aria-label="Human name"]'), 'Uncommitted profile')
    await click('Cancel'); await click('Personal settings')
    assert.notEqual(doc.querySelector('input[aria-label="Human name"]').value, 'Uncommitted profile')
    assert.equal(calls.some(call => call.endpoint === 'profile-human'), false)
    await click('Cancel'); await click('Shared group')
    assert.equal(doc.querySelector('button[aria-label="Close on this device"]'), null)
    assert.ok(doc.querySelector('nav button[data-conversation-id="group"]'))
  })
})

test('floating replies show chronological messages without repeated quotes and preserve reply targets and read-only controls', async () => {
  const snapshot = { ...state(), conversations: [{ ...membership }] }
  const events = ['Root', 'Child', 'Another branch', 'Late deep reply'].map((text, i) => ({ type: 'message', conversationSeq: i + 1, serverAcceptedAt: '2026-11-04T00:00:00Z', message: { messageId: `m${i}`, author: membership.info.members[0], content: { text }, mentions: [], replyToMessageId: i === 3 ? 'm1' : i ? 'm0' : null } }))
  await pane({ snapshot, history: events, handle: async body => body.endpoint === 'thread' ? { conversationId: 'group', membershipEpoch: 'epoch', messageId: body.messageId, rootMessageId: 'm0', watermark: 4, events, hasMore: false } : {} }, async ({ autoRefresh, doc, click, edit, calls }) => {
    await click('Shared group')
    await click('View replies')
    assert.equal(doc.querySelectorAll('.bt-comm-thread-log article').length, 4)
    assert.deepEqual([...doc.querySelectorAll('.bt-comm-thread-log article')].map(node=>node.dataset.threadMessageId),['m0','m1','m2','m3'])
    assert.equal(doc.querySelector('.bt-comm-thread-parent'),null)
    assert.equal(doc.querySelector('.bt-comm-thread-branches'),null)
    assert.equal(events[3].message.replyToMessageId,'m1','display flattening retains canonical reply relationships')
    assert.ok(doc.querySelector('.bt-comm-log [data-message-id="m3"] .bt-comm-message-bubble'),'main conversation remains intact')
    await act(async () => doc.querySelector('[data-thread-message-id="m2"] button[aria-label="Reply"]').click())
    await edit(doc.querySelector('.bt-comm-thread-composer textarea'), 'Continue this exact reply')
    await click('Send reply')
    assert.equal(calls.find(call => call.endpoint === 'send').replyToMessageId, 'm2')
    await click('Close replies')
    snapshot.conversations[0].speakingMode = 'readOnly'; await autoRefresh()
    assert.equal(doc.querySelector('footer'), null)
    assert.ok(doc.querySelector('.bt-comm-log button[aria-label="View replies"]'))
    assert.ok(doc.querySelector('.bt-comm-log button[aria-label="Copy"]'))
    assert.equal(doc.querySelector('.bt-comm-log button[aria-label="Reply"]'), null)
    await click('View replies')
    assert.equal(doc.querySelector('.bt-comm-thread button[aria-label="Reply"]'), null)
    assert.equal(doc.querySelectorAll('.bt-comm-thread-log article').length, 4)
    assert.equal(calls.filter(call => call.endpoint === 'send').length, 1)
  })
})

test('message hover icons copy without sending and open only the selected branch with its own reply composer',async()=>{
 const events=['Root','Selected branch','Child','Unrelated sibling'].map((text,i)=>({type:'message',conversationSeq:i+1,serverAcceptedAt:'2026-11-04T00:00:00Z',message:{messageId:`m${i}`,author:membership.info.members[0],content:{text},mentions:[],replyToMessageId:i===2?'m1':i?'m0':null}}))
 let copied=''
 await pane({snapshot:{...state(),conversations:[membership]},history:events,handle:async body=>body.endpoint==='thread'?{conversationId:'group',membershipEpoch:'epoch',messageId:body.messageId,rootMessageId:'m0',watermark:4,events,hasMore:false}:{}},async({dom,doc,click,edit,calls})=>{
  Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async value=>{copied=value}}})
  await click('Shared group')
  await edit(doc.querySelector('footer textarea'),'Keep my main draft')
  const selected=doc.querySelector('[data-message-id="m1"]')
  await act(async()=>selected.querySelector('button[aria-label="Copy"]').click())
  assert.equal(copied,'Selected branch');assert.ok(selected.querySelector('button[aria-label="Copied"]'))
  assert.equal(calls.some(call=>call.endpoint==='send'),false)
  const trigger=selected.querySelector('button[aria-label="Reply"]')
  await act(async()=>trigger.click())
  const popup=doc.querySelector('.bt-comm-thread-popover');assert.equal(popup.getAttribute('role'),'dialog')
  assert.equal(doc.querySelectorAll('.bt-comm-thread-log article').length,2)
  assert.equal(doc.querySelector('[data-thread-message-id="m0"]'),null)
  assert.equal(doc.querySelector('[data-thread-message-id="m3"]'),null)
  await edit(popup.querySelector('textarea'),'Reply from the floating window')
  await click('Send reply')
  const send=calls.find(call=>call.endpoint==='send')
  assert.equal(send.replyToMessageId,'m1');assert.equal(send.text,'Reply from the floating window')
  assert.equal(doc.querySelector('footer textarea').value,'Keep my main draft')
  await click('Close replies')
  assert.equal(doc.querySelector('.bt-comm-thread-popover'),null);assert.equal(doc.activeElement,trigger)
 })
})

test('an uncertain floating reply keeps its original identity across close/reopen and a terminal denial unlocks editing',async()=>{
 const event={type:'message',conversationSeq:1,serverAcceptedAt:'2026-11-04T00:00:00Z',message:{messageId:'root',author:membership.info.members[0],content:{text:'Reply target'},mentions:[],replyToMessageId:null}}
 let attempts=0
 await pane({snapshot:{...state(),conversations:[membership]},history:[event],handle:async body=>{
  if(body.endpoint==='thread')return {conversationId:'group',membershipEpoch:'epoch',messageId:'root',rootMessageId:'root',watermark:1,events:[event],hasMore:false}
  if(body.endpoint==='send'){attempts++;throw Object.assign(new Error('Synthetic failure'),{code:attempts===1?'REQUEST_TIMEOUT':'FORBIDDEN'})}
  return {}
 }},async({doc,click,edit,calls})=>{
  await click('Shared group');await click('Reply')
  await edit(doc.querySelector('.bt-comm-thread-composer textarea'),'One logical reply')
  await click('Send reply')
  const first=calls.find(call=>call.endpoint==='send')
  assert.equal(doc.querySelector('.bt-comm-thread-composer textarea').disabled,true)
  await click('Close replies');await click('Reply');await click('Retry same send')
  const sends=calls.filter(call=>call.endpoint==='send');assert.equal(sends.length,2)
  assert.deepEqual(sends[1],first)
  assert.equal(doc.querySelector('.bt-comm-thread-composer textarea').disabled,false)
  assert.equal(doc.querySelector('.bt-comm-thread-composer textarea').value,'One logical reply')
  assert.equal(doc.querySelector('.bt-comm-log').textContent.includes('Synthetic failure'),false)
 })
})

test('late thread responses cannot survive a selected conversation change or membership revocation', async () => {
  const snapshot = { ...state(), conversations: [{ ...membership }, { ...membership, conversationId: 'other', title: 'Other group', membershipEpoch: 'other' }] }
  const event = { type: 'message', conversationSeq: 1, serverAcceptedAt: '2026-11-04T00:00:00Z', message: { messageId: 'late', author: membership.info.members[0], content: { text: 'Thread canary' }, mentions: [] } }
  let release
  await pane({ snapshot, history: [event], handle: body => body.endpoint === 'thread' ? new Promise(resolve => { release = resolve }) : {} }, async ({ autoRefresh, doc, click }) => {
    await click('Shared group'); await click('View replies')
    await click('Cancel'); await click('Other group')
    await act(async () => release({ conversationId: 'group', membershipEpoch: 'epoch', messageId: 'late', rootMessageId: 'late', events: [event] }))
    assert.equal(doc.querySelector('.bt-comm-thread'), null)
    snapshot.conversations = []; await autoRefresh()
    assert.equal(doc.querySelector('footer'), null)
    assert.equal(doc.querySelector('.bt-comm-thread'), null)
  })
})

test('unconfigured communication explains pairing without API calls, and keyboard users can return to local chats', async () => {
  await pane({ enabled: false }, async ({ doc, dom, panel, calls, button, click }) => {
    assert.ok(doc.querySelector('[role=dialog][aria-modal=true]'))
    assert.match(doc.querySelector('.bt-comm-main').textContent, /Ask the Hub owner to configure communication/)
    await click('New…')
    assert.equal(button('New group').disabled, true)
    assert.equal(calls.length, 0)
    await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(panel.getSnapshot(), true, 'Escape closes the creation submenu first')
    await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(panel.getSnapshot(), false)
    assert.equal(doc.getElementById('native').value, 'private draft')
  })
})

test('partial invitations preserve the created group and never create another group or silently retry invitations', async () => {
  const snapshot = state(), invitations = []
  snapshot.contacts = ['human:b:person', 'bot:b:chief'].map((principalId, index) => ({ principalId, displayName: index ? 'Chief' : 'Person', homeInstanceId: 'b', instanceLabel: 'Other device', kind: index ? 'bot' : 'human' }))
  await pane({ snapshot, handle: async body => {
    if (body.endpoint === 'create-group') { snapshot.conversations = [membership]; return { conversationId: 'group' } }
    if (body.endpoint === 'invite') { invitations.push(body); if (invitations.length === 2) throw Object.assign(new Error('denied'), { code: 'FORBIDDEN' }); return {} }
    throw new Error('Unexpected mutation')
  } }, async ({ doc, calls, click, edit }) => {
    await click('New group')
    assert.equal(doc.activeElement, doc.querySelector('input[aria-label="Group name"]'))
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Review group')
    for (const checkbox of doc.querySelectorAll('.bt-comm-check input')) await act(async () => checkbox.click())
    await click('Create and invite')
    assert.equal(calls.filter(call => call.endpoint === 'create-group').length, 1)
    assert.equal(invitations.length, 2)
    assert.equal(new Set(invitations.map(item => item.inviteePrincipalId)).size, 2)
    assert.equal(doc.querySelector('.bt-comm-main h2').textContent, 'Shared group')
    assert.equal(doc.querySelector('.bt-comm-modal'), null)
    assert.equal(doc.querySelector('input[aria-label="Group name"]'), null)
    assert.match(doc.querySelector('.bt-comm-toast').textContent, /Group created\. Some invitations were not sent/)
    assert.match(doc.querySelector('.bt-comm-main header').textContent, /Group owner.*Can speak/)
    assert.equal(doc.querySelector('.bt-comm-frame').dataset.browse, 'false')
  })
})

test('connection recovery refreshes status without resending failures and navigation preserves the draft', async () => {
  const snapshot = state(); snapshot.conversations = [membership]; snapshot.connected = false; snapshot.error = 'UNAUTHENTICATED'
  snapshot.outbox = [{ type: 'message.publish', id: 'failed', conversationId: 'group', state: 'failed', text: 'Original denied message', error: 'SPEAKING_FORBIDDEN' }]
  await pane({ snapshot }, async ({ autoRefresh, doc, dom, panel, click, edit, calls }) => {
    await click('Shared group')
    assert.match(doc.querySelector('.bt-comm-connection').textContent, /Offline/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-connection').textContent, /Reconnecting to Hub/)
    assert.doesNotMatch(doc.querySelector('aside').textContent, /Ask the Hub owner to check its pairing|Operation failed|Error code/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-main').textContent, /Ask the Hub owner to check its pairing/)
    await click('Activity details')
    assert.match(doc.querySelector('.bt-comm-activity').textContent, /Ask the Hub owner to check its pairing/)
    assert.equal(doc.querySelector('article[data-failed=true]'), null)
    assert.match(doc.querySelector('.bt-comm-activity').textContent, /read-only access/)
    await click('Cancel')
    await edit(doc.querySelector('textarea[aria-label="Communication message"]'), 'Preserved draft')
    await click('Conversations'); assert.equal(doc.querySelector('.bt-comm-frame').dataset.browse, 'true')
    await click('Back to conversation'); assert.equal(doc.querySelector('.bt-comm-frame').dataset.browse, 'false')
    const memberSettings = doc.querySelector('.bt-comm-members')
    await act(async () => memberSettings.querySelector('summary').click())
    assert.equal(memberSettings.open, true)
    await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(memberSettings.open, false)
    assert.equal(panel.getSnapshot(), true)
    await act(async () => memberSettings.querySelector('summary').click())
    await click('Close member settings')
    assert.equal(doc.activeElement, doc.querySelector('.bt-comm-title-pill'))
    await autoRefresh()
    assert.equal(calls.filter(call => call.endpoint === 'send').length, 0)
    assert.equal(doc.querySelector('textarea[aria-label="Communication message"]').value, 'Preserved draft')
    assert.equal(doc.querySelector('.bt-comm-status-help'), null)
  })
})


test('contact modals group observed IPs and retain separate NAT instance identities and avatars', async () => {
  const snapshot = state()
  snapshot.contacts = ['b', 'c'].map(id => ({ principalId: `human:${id}:person`, displayName: 'Same name', homeInstanceId: id, instanceLabel: 'Office', kind: 'human', ipAddress: '192.0.2.1' }))
  await pane({ snapshot, handle: async body => { assert.equal(body.endpoint, 'dm'); return {} } }, async ({ doc, dom, calls, click }) => {
    await click('New message')
    assert.equal(doc.querySelectorAll('.bt-comm-modal .bt-comm-address').length, 1)
    assert.equal(doc.querySelectorAll('.bt-comm-modal .bt-comm-address section').length, 2)
    assert.equal(doc.querySelector('aside [data-panel]'), null)
    assert.equal(doc.querySelectorAll('.bt-comm-modal [data-avatar-id]').length, 2)
    const contacts = doc.querySelectorAll('.bt-comm-modal .bt-comm-contact')
    await act(async () => contacts[1].click())
    assert.equal(calls.find(call => call.endpoint === 'dm').otherPrincipalId, 'human:c:person')
    await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(doc.querySelector('.bt-comm-modal'), null)
  })
})

test('typed mentions support arrows, exact same-name IDs, IME, escape and reserved @all without selects', async () => {
  const snapshot = state()
  snapshot.conversations = [{ ...membership, info: { members: [
    ...membership.info.members,
    { principalId: 'bot:a:one', displayName: 'Twin', kind: 'bot' },
    { principalId: 'bot:b:two', displayName: 'Twin', kind: 'bot' },
  ] } }]
  await pane({ snapshot }, async ({ doc, dom, calls, click, edit }) => {
    await click('Shared group')
    const field = doc.querySelector('.bt-comm-main textarea')
    await edit(field, '@Tw')
    assert.equal(doc.querySelectorAll('[role=option]').length, 2)
    assert.equal(doc.querySelector('footer select'), null)
    await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    assert.equal(calls.filter(call => call.endpoint === 'send').length, 0)
    await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    assert.equal(field.value, '@Twin ')
    const drafts = JSON.parse(dom.window.sessionStorage.getItem('ds-bot:communication:drafts'))
    assert.deepEqual(drafts['a:group'].mentions, ['bot:b:two'])
    await edit(field, 'Mention removed')
    assert.deepEqual(JSON.parse(dom.window.sessionStorage.getItem('ds-bot:communication:drafts'))['a:group'].mentions, [])
    await edit(field, '@all')
    assert.equal(doc.querySelector('[role=option]').textContent, 'All Bots')
    await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })))
    assert.equal(field.value, '@all ')
    await edit(field, '@')
    await act(async () => field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(doc.querySelector('[role=listbox]'), null)
    assert.ok(doc.querySelector('.bt-comm-frame'))
  })
})

test('Human and group rename send authenticated versioned requests and failed sends cannot overwrite a draft', async () => {
  const snapshot = state(); snapshot.conversations = [membership]
  snapshot.outbox = [{ type: 'message.publish', id: 'failed', conversationId: 'group', state: 'failed', text: 'Denied original', error: 'FORBIDDEN' }]
  await pane({ snapshot }, async ({ doc, calls, click, edit, button }) => {
    await click('Shared group')
    await click('Personal settings')
    await edit(doc.querySelector('input[aria-label="Human name"]'), 'Renamed Human')
    await click('Save profile')
    assert.equal(calls.find(call => call.endpoint === 'profile-human').displayName, 'Renamed Human')
    await click('Cancel')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Renamed group')
    await click('Save')
    const configure = calls.find(call => call.endpoint === 'save-settings')
    assert.equal(configure.title, 'Renamed group')
    assert.equal(configure.conversationId, 'group')
    assert.equal(configure.membershipEpoch, 'epoch')
    assert.equal(configure.expectedVersion, 1)
    assert.ok(configure.operationId)
    await edit(doc.querySelector('.bt-comm-main textarea'), 'Existing draft')
    await click('Activity details')
    assert.equal(button('Copy to draft').disabled, true)
    await click('Cancel')
    await edit(doc.querySelector('.bt-comm-main textarea'), '')
    await click('Activity details')
    await click('Copy to draft')
    assert.equal(doc.querySelector('.bt-comm-main textarea').value, 'Denied original')
    assert.equal(calls.filter(call => call.endpoint === 'send').length, 0)
  })
})


test('pairing guide is available before and after configuration and never performs API mutations', async () => {
  for (const enabled of [false, true]) {
    await pane({ enabled, snapshot: state(), handle: async body => { if(body.endpoint==='memory-settings')return {localMemory:true};assert.equal(body.endpoint, 'onboarding-storage'); return { storage: { defaultProvider: 'owner-acl-plaintext', encryptedByDefault: false, agentIsolation: false }, enrollments: [] } } }, async ({ doc, dom, calls, click, panel }) => {
      await click('Personal settings')
      await click('Join Hub')
      const guide = doc.querySelector('.bt-comm-modal[aria-label="Pairing guide"]')
      assert.ok(guide)
      assert.match(guide.textContent, /Hub owner must authorize each device.*restart the Hub/)
      assert.match(guide.textContent, /does not pair a device or change permissions/)
      assert.match(guide.textContent, /environment variable names may differ/)
      assert.match(guide.textContent, /local secret mechanism/)
      assert.match(guide.textContent, /publishedBotIds/)
      assert.match(guide.textContent, /Each instance has one person identity/)
      assert.match(guide.textContent, /Readiness alone does not prove pairing/)
      const peer = JSON.parse(guide.querySelector('pre[aria-label="Hub configuration example"]').textContent).peers[0]
      assert.equal(peer.instanceId, 'new-device')
      assert.equal(peer.credentialEnv, 'DSBOT_HUB_NEW_DEVICE_CREDENTIAL')
      assert.equal(Object.hasOwn(peer, 'credential'), false)
      assert.match(guide.querySelector('pre[aria-label="Device configuration example"]').textContent, /url: wss:\/\/hub.example.test:3190\/communication/)
      assert.ok(guide.querySelector('[aria-label="Hub code"]'))
      assert.equal(guide.querySelector('.bt-comm-manual-guide').open, false)
      assert.equal(calls.filter(call => !['state', 'onboarding-storage', 'memory-settings'].includes(call.endpoint)).length, 0)
      await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      assert.equal(doc.querySelector('.bt-comm-modal'), null)
      assert.equal(panel.getSnapshot(), true)
      assert.equal(calls.filter(call => !['state', 'onboarding-storage', 'memory-settings'].includes(call.endpoint)).length, 0)
    })
  }
})


test('choosing a legacy Human called all keeps a visible removable explicit target and sends no broadcast text', async () => {
  const snapshot = state(), human = { principalId: 'human:b:all', displayName: 'all', kind: 'human' }
  snapshot.contacts = [human]
  snapshot.conversations = [{ ...membership, info: { members: [...membership.info.members, human, { principalId: 'bot:a:one', displayName: 'Twin', kind: 'bot' }] } }]
  await pane({ snapshot }, async ({ doc, dom, calls, click, edit }) => {
    await click('Shared group')
    const field = doc.querySelector('.bt-comm-main textarea')
    const chooseHuman = async () => {
      await edit(field, '@all')
      const choices = doc.querySelectorAll('[role=option]')
      assert.equal(choices.length, 2)
      await act(async () => choices[1].click())
      assert.equal(field.value, 'all ')
    }
    await chooseHuman()
    assert.ok(doc.querySelector('.bt-comm-mentions [data-manual-mention=true]'))
    await edit(field, 'Changed ordinary text')
    assert.deepEqual(JSON.parse(dom.window.sessionStorage.getItem('ds-bot:communication:drafts'))['a:group'].manualMentions, ['human:b:all'])
    await act(async () => doc.querySelector('.bt-comm-mentions button').click())
    let draft = JSON.parse(dom.window.sessionStorage.getItem('ds-bot:communication:drafts'))['a:group']
    assert.deepEqual(draft.manualMentions, [])
    assert.deepEqual(draft.mentions, [])
    await chooseHuman()
    await click('Send message')
    const sent = calls.find(call => call.endpoint === 'send')
    assert.deepEqual([...sent.mentions], ['human:b:all'])
    assert.equal(sent.text, 'all ')
    assert.equal(doc.querySelector('.bt-comm-mentions button'), null)
    draft = JSON.parse(dom.window.sessionStorage.getItem('ds-bot:communication:drafts'))['a:group']
    assert.deepEqual(draft.manualMentions, [])
    await edit(field, '@all')
    await click('Send message')
    const native = calls.filter(call => call.endpoint === 'send')[1]
    assert.equal(native.text, '@all')
    assert.equal(native.mentions.length, 0)
  })
})


test('an uncertain group creation reuses its persisted operation ID after a full surface remount', async () => {
  const snapshot = state(), attempts = []
  await pane({ snapshot, handle: async body => {
    assert.equal(body.endpoint, 'create-group')
    attempts.push(body)
    if (attempts.length === 1) throw Object.assign(new Error('Hub ACK lost'),{code:'REQUEST_TIMEOUT'})
    snapshot.conversations = [membership]
    return { conversationId: 'group' }
  } }, async ({ doc, dom, click, edit, remount }) => {
    await click('New group')
    await edit(doc.querySelector('.bt-comm-modal input'), 'One group')
    await click('Create and invite')
    let persisted = JSON.parse(dom.window.sessionStorage.getItem('ds-bot:communication:operation-ids'))
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0][1], attempts[0].operationId)
    await click('Cancel')
    await click('Activity details')
    assert.match(doc.querySelector('.bt-comm-activity').textContent, /operation is not confirmed/)
    await remount()
    await click('New group')
    await edit(doc.querySelector('.bt-comm-modal input'), 'One group')
    await click('Create and invite')
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].operationId, attempts[1].operationId)
    assert.equal(attempts[0].title, attempts[1].title)
    persisted = JSON.parse(dom.window.sessionStorage.getItem('ds-bot:communication:operation-ids'))
    assert.deepEqual(persisted, [])
    assert.equal(doc.querySelector('.bt-comm-main h2').textContent, 'Shared group')
  })
})


test('member permissions explain authorized delegation for both Bot modes without permitting passive tool initiation', async () => {
  const snapshot = state()
  snapshot.conversations = [{ ...membership, info: { members: [...membership.info.members,
    { principalId: 'bot:a:passive', displayName: 'Passive', kind: 'bot', role: 'member', speakingMode: 'passive' },
    { principalId: 'bot:a:active', displayName: 'Active', kind: 'bot', role: 'member', speakingMode: 'active' },
  ] } }]
  await pane({ snapshot }, async ({ doc, click, calls }) => {
    await click('Shared group')
    const drawer = doc.querySelector('.bt-comm-members')
    await act(async () => drawer.querySelector('summary').click())
    assert.match(drawer.textContent, /Both Bot modes may @mention current group Bots in an authorized final reply/)
    assert.match(drawer.textContent, /Reply-only Bots cannot initiate messages or send proactively with tools/)
    assert.match(drawer.textContent, /Active Bots may also initiate with tools/)
    assert.match(drawer.textContent, /delegation chains stop at the server’s finite limit/)
    const modes = [...drawer.querySelectorAll('select[aria-label="Speaking permission"]')].map(node => node.value)
    assert.ok(modes.includes('passive'))
    assert.ok(modes.includes('active'))
    assert.equal(calls.some(call => ['send', 'policy'].includes(call.endpoint)), false)
  })
})


test('causal-limit stops render once outside chat from canonical history or an accepted ACK without automatic retry', async () => {
  const message = { messageId: 'stopped-message', author: { principalId: 'bot:a:one', displayName: 'One' }, content: { text: 'Original final reply remains visible' }, mentions: [], replyToMessageId: null }
  const causality = { rootMessageId: 'human-root', parentMessageId: 'previous-bot', depth: 8 }
  const event = { type: 'message', eventId: 'stopped-event', conversationSeq: 2, serverAcceptedAt: '2026-11-04T00:00:00Z', message, causality, dispatchSuppressed: 'CAUSAL_LIMIT' }
  for (const history of [[event], []]) {
    const snapshot = state(); snapshot.conversations = [membership]
    snapshot.outbox = [{ id: message.messageId, type: 'message.publish', conversationId: 'group', state: 'accepted', text: message.content.text, deliveries: [], result: { conversationSeq: 2, causality, dispatchSuppressed: 'CAUSAL_LIMIT' } }]
    await pane({ snapshot, history }, async ({ doc, calls, click }) => {
      await click('Shared group')
      assert.equal(doc.querySelector('.bt-comm-feedback'), null)
      await click('Activity details')
      const feedback = doc.querySelector('.bt-comm-activity')
      assert.equal(feedback.querySelectorAll('[data-causal-stop]').length, 1)
      assert.match(feedback.textContent, /Bot collaboration stopped at the safety limit. Send a new Human message to continue/)
      assert.equal([...feedback.querySelectorAll('button')].some(node => /Retry|Send message/.test(node.textContent)), false)
      assert.doesNotMatch(doc.querySelector('.bt-comm-log').textContent, /safety limit/)
      assert.equal(doc.querySelector('article[data-failed=true]'), null)
      if (history.length) assert.match(doc.querySelector('.bt-comm-log').textContent, /Original final reply remains visible/)
      assert.equal(calls.some(call => ['send', 'retry'].includes(call.endpoint)), false)
      assert.equal(message.content.text, 'Original final reply remains visible')
    })
  }
})


test('one dirty Save atomically submits the drawer draft and closing discards unsaved edits', async () => {
  const snapshot = state()
  const bot = { principalId: 'bot:a:one', displayName: 'One', kind: 'bot', role: 'member', speakingMode: 'passive' }
  snapshot.contacts = [bot]
  snapshot.conversations = [{ ...membership, info: { members: [...membership.info.members, bot] } }]
  await pane({ snapshot, handle: async body => {
    assert.equal(body.endpoint, 'save-settings')
    const current = snapshot.conversations[0]
    snapshot.conversations = [{ ...current, title: body.title, routingMode: body.routing.mode, adminBotPrincipalId: body.routing.adminBotPrincipalId, membershipVersion: 2, info: { members: current.info.members.map(person => person.principalId === bot.principalId ? { ...person, ...body.policies[0] } : person) } }]
    return { updated: true, conversationId: 'group', membershipVersion: 2 }
  } }, async ({ doc, click, edit, calls, button }) => {
    await click('Shared group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    const save = () => doc.querySelector('[aria-label="Save group settings"]')
    assert.equal(save().disabled, true)
    assert.equal([...doc.querySelectorAll('.bt-comm-members button')].filter(node => node.textContent.startsWith('Save')).length, 1)
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Atomic title')
    await edit(doc.querySelector('[data-principal-id="bot:a:one"] select[aria-label="Speaking permission"]'), 'active')
    await edit(doc.querySelector('select[aria-label="Receiving rule"]'), 'admin')
    const reply = [...doc.querySelectorAll('.bt-comm-participant-picker')].find(node => node.querySelector('summary').textContent.startsWith('Default reply Bot'))
    await act(async () => reply.querySelector('summary').click())
    await act(async () => reply.querySelector('button').click())
    assert.equal(save().dataset.dirty, 'true')
    assert.equal(calls.some(call => ['policy', 'routing', 'configure-group'].includes(call.endpoint)), false)
    await click('Save')
    const sent = calls.find(call => call.endpoint === 'save-settings')
    assert.equal(sent.title, 'Atomic title')
    assert.equal(sent.expectedVersion, 1)
    assert.equal(sent.membershipEpoch, 'epoch')
    assert.equal(sent.routing.adminBotPrincipalId, bot.principalId)
    assert.equal(sent.policies[0].speakingMode, 'active')
    assert.equal(save().disabled, true)
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Discard me')
    await click('Close member settings')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    assert.equal(doc.querySelector('input[aria-label="Group name"]').value, 'Atomic title')
    assert.equal(button('Save').disabled, true)
  })
})

test('concurrent polling and a stale save retain edits until the drawer is closed and reopened', async () => {
  const snapshot = state(); snapshot.conversations = [{ ...membership }]
  await pane({ snapshot, handle: async body => { assert.equal(body.expectedVersion, 1); throw Object.assign(new Error('stale'), { code: 'GROUP_VERSION_CONFLICT' }) } }, async ({ autoRefresh, doc, click, edit }) => {
    await click('Shared group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Local draft')
    snapshot.conversations = [{ ...membership, title: 'Elsewhere', membershipVersion: 2 }]
    await autoRefresh()
    assert.equal(doc.querySelector('input[aria-label="Group name"]').value, 'Local draft')
    await click('Save')
    assert.equal(doc.querySelector('input[aria-label="Group name"]').value, 'Local draft')
    assert.match(doc.querySelector('.bt-comm-members [role=alert]').textContent, /Group settings changed/)
    assert.equal(doc.querySelector('[aria-label="Save group settings"]').dataset.dirty, 'true')
    await click('Close member settings')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    assert.equal(doc.querySelector('input[aria-label="Group name"]').value, 'Elsewhere')
  })
})

test('an uncertain settings save preserves newer edits and retries the same payload and ID before sending new edits', async () => {
  const snapshot = state(); snapshot.conversations = [{ ...membership }]
  const attempts = []; let rejectFirst
  await pane({ snapshot, handle: async body => {
    attempts.push(body)
    if (attempts.length === 1) return new Promise((_resolve, reject) => { rejectFirst = reject })
    snapshot.conversations = [{ ...snapshot.conversations[0], title: body.title, membershipVersion: attempts.length }]
    return { updated: true, membershipVersion: attempts.length, conversationId: 'group' }
  } }, async ({ doc, click, edit }) => {
    await click('Shared group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'First submitted')
    await click('Save')
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Newer local edit')
    await act(async () => rejectFirst(new TypeError('response lost')))
    await click('Save')
    assert.equal(attempts[0].operationId, attempts[1].operationId)
    assert.equal(attempts[1].title, 'First submitted')
    assert.equal(doc.querySelector('input[aria-label="Group name"]').value, 'Newer local edit')
    assert.equal(doc.querySelector('[aria-label="Save group settings"]').dataset.dirty, 'true')
    await click('Save')
    assert.equal(attempts[2].title, 'Newer local edit')
    assert.equal(attempts[2].expectedVersion, 2)
    assert.equal(doc.querySelector('[aria-label="Save group settings"]').disabled, true)
  })
})

test('late settings responses cannot overwrite another group or a reopened drawer', async () => {
  const snapshot = state(); snapshot.conversations = [{ ...membership }, { ...membership, conversationId: 'other', title: 'Other group' }]
  let release
  await pane({ snapshot, handle: async body => new Promise(resolve => { release = () => { snapshot.conversations[0] = { ...membership, title: body.title, membershipVersion: 2 }; resolve({ updated: true, conversationId: 'group', membershipVersion: 2 }) } }) }, async ({ autoRefresh, doc, click, edit }) => {
    await click('Shared group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Submitted')
    await click('Save')
    await click('Close member settings')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Reopened edit')
    await act(async () => release())
    assert.equal(doc.querySelector('input[aria-label="Group name"]').value, 'Reopened edit')
    await click('Other group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Other local edit')
    await autoRefresh()
    assert.equal(doc.querySelector('input[aria-label="Group name"]').value, 'Other local edit')
  })
})

test('all group members can inspect current member information while non-managers have no edit controls', async () => {
  const snapshot = state(); snapshot.conversations = [{ ...membership, role: 'member', speakingMode: 'readOnly' }]
  await pane({ snapshot }, async ({ doc, click, calls }) => {
    await click('Shared group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    const drawer = doc.querySelector('.bt-comm-members')
    assert.match(drawer.textContent, /Owner/)
    assert.equal(drawer.querySelector('select,input'), null)
    assert.equal(drawer.querySelector('[aria-label="Save group settings"]'), null)
    assert.equal(calls.some(call => call.endpoint === 'save-settings'), false)
  })
})

test('routine membership changes produce no notice or empty feedback box', async () => {
  const snapshot = state(); snapshot.conversations = [membership]
  await pane({ snapshot, history: [{ type: 'membership.policy', eventId: 'policy', conversationSeq: 2 }] }, async ({ doc, click }) => {
    await click('Shared group')
    assert.doesNotMatch(doc.querySelector('.bt-comm-frame').textContent, /Membership or receiving rule changed/)
    assert.equal(doc.querySelector('.bt-comm-event'), null)
    assert.equal(doc.querySelector('.bt-comm-feedback'), null)
  })
})


test('reference previews use authorized short Unicode text and jump once without scroll locking or focus theft', async () => {
  const snapshot = state(); snapshot.conversations = [{ ...membership, watermark: 2 }]
  const source = { type: 'message', eventId: 'source-event', conversationSeq: 1, serverAcceptedAt: '2026-11-04T00:00:00Z', message: { messageId: 'source', author: { principalId: 'human:b:source', displayName: 'Source author' }, content: { text: '😀'.repeat(180) }, mentions: [] } }
  const reply = { ...source, eventId: 'reply-event', conversationSeq: 2, message: { messageId: 'reply', author: { principalId: 'human:a:owner' }, content: { text: 'A reply' }, mentions: [], replyToMessageId: 'source' } }
  await pane({ snapshot, history: [source, reply], handle: async body => { assert.equal(body.endpoint, 'reference'); assert.equal(body.conversationId, 'group'); return source } }, async ({ autoRefresh, doc, dom, click }) => {
    let jumps = 0
    dom.window.HTMLElement.prototype.scrollIntoView = function () { if (this.dataset.messageId === 'source') jumps += 1 }
    await click('Shared group')
    const quote = doc.querySelector('.bt-comm-quote')
    assert.equal(quote.getAttribute('aria-label'), 'Jump to source message')
    assert.equal(quote.querySelector('.bt-comm-quote-author').textContent, 'Source author')
    const excerpt = quote.querySelector('.bt-comm-quote-text').textContent
    assert.equal([...excerpt].length, 160)
    assert.ok(excerpt.endsWith('…'))
    await act(async () => { quote.focus(); quote.click() })
    assert.equal(jumps, 1)
    assert.equal(doc.activeElement, quote)
    assert.equal(doc.querySelector('[data-message-id="source"]').dataset.referenced, 'true')
    const log = doc.querySelector('.bt-comm-log')
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
    log.scrollTop = 123
    await act(async () => log.dispatchEvent(new dom.window.Event('scroll', { bubbles: true })))
    snapshot.conversations[0] = { ...snapshot.conversations[0], watermark: 3 }
    await autoRefresh()
    assert.equal(jumps, 1)
    assert.equal(log.scrollTop, 123)
    await act(async () => doc.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })))
    assert.equal(doc.querySelector('[data-message-id="source"]').dataset.referenced, 'false')
    assert.equal(doc.activeElement, quote)
    assert.equal(log.scrollTop, 123)
    await act(async () => quote.click())
    assert.equal(jumps, 2)
  })
})

test('unavailable reference previews show only a generic message and never render an API error payload', async () => {
  const snapshot = state(); snapshot.conversations = [membership]
  const reply = { type: 'message', eventId: 'reply', conversationSeq: 2, serverAcceptedAt: '2026-11-04T00:00:00Z', message: { messageId: 'reply', author: { principalId: 'human:a:owner' }, content: { text: 'Public reply' }, mentions: [], replyToMessageId: 'private-source' } }
  await pane({ snapshot, history: [reply], handle: async () => { throw Object.assign(new Error('private source contents must never leak'), { code: 'REFERENCE_NOT_AVAILABLE' }) } }, async ({ doc, click }) => {
    await click('Shared group')
    assert.equal(doc.querySelector('.bt-comm-quote').textContent, 'Earlier message unavailable')
    assert.equal(doc.querySelector('.bt-comm-quote').disabled, true)
    assert.doesNotMatch(doc.querySelector('.bt-comm-frame').textContent, /private source contents/)
  })
})

test('an acknowledged settings save stays confirmed when the follow-up status read fails', async () => {
  const snapshot = state(); snapshot.conversations = [membership]
  let unavailable = false; const versions = []
  await pane({ snapshot, getState: () => { if (unavailable) throw new TypeError('status unavailable'); return { ...snapshot } }, handle: async body => {
    versions.push(body.expectedVersion); unavailable = true
    return { updated: true, conversationId: 'group', membershipVersion: body.expectedVersion + 1 }
  } }, async ({ doc, click, edit }) => {
    await click('Shared group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Committed')
    await click('Save')
    assert.equal(doc.querySelector('[aria-label="Save group settings"]').disabled, true)
    assert.equal(doc.querySelector('.bt-comm-members [role=alert]'), null)
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Next committed')
    await click('Save')
    assert.deepEqual(versions, [1, 2])
    assert.equal(doc.querySelector('[aria-label="Save group settings"]').disabled, true)
  })
})

test('canonical started history deduplicates beneath messages and member chips open only read-only participant information', async () => {
  const bot = { principalId: 'bot:a:chief', kind: 'bot', displayName: 'Chief', homeInstanceId: 'a', role: 'member', speakingMode: 'passive' }
  const snapshot = { ...state(), contacts: [bot], conversations: [{ ...membership, role: 'member', info: { members: [...membership.info.members, bot] } }] }
  const started = { type: 'bot.work.started', eventId: 'bot-work-started:d1', deliveryId: 'd1', messageId: 'm1', principalId: bot.principalId, serverStartedAt: '2026-11-04T00:00:00.000Z', conversationSeq: 2 }
  const history = [{ type: 'message', serverAcceptedAt: '2026-11-04T00:00:00.000Z', conversationSeq: 1, message: { messageId: 'm1', author: membership.info.members[0], mentions: [{ principalId: bot.principalId }], content: { text: 'Please ask @Chief' } } }, started, structuredClone(started), { type: 'receipt', aiAccepted: true, conversationSeq: 3 }]
  const MarkdownText = ({ text }) => {
    const match = text.match(/\[([^\]]*)\]\((https:\/\/remote-mentions\.dsbot\.invalid\/[^)]+)\)/)
    return React.createElement('p', null, match ? React.createElement('a', { href: match[2] }, match[1]) : text)
  }
  await pane({ snapshot, history, MarkdownText }, async ({ doc, calls, click }) => {
    await click('Shared group')
    assert.equal(doc.querySelectorAll('.bt-comm-log article').length, 1)
    assert.equal(doc.querySelectorAll('.bt-comm-work-started').length, 1)
    assert.equal(doc.querySelector('.bt-comm-work-started').previousElementSibling.dataset.messageId, 'm1')
    await act(async () => doc.querySelector('.bt-comm-inline-mention').click())
    const inspector = doc.querySelector('[role=dialog][aria-label="Participant information"]')
    assert.ok(inspector)
    assert.equal(inspector.querySelector('code').textContent, bot.principalId)
    assert.equal(inspector.querySelector('input,select,textarea'), null)
    assert.equal(inspector.querySelectorAll('button').length, 2)
    assert.ok(inspector.querySelector('[aria-label="Close dialog"]'))
    assert.ok(calls.every(body => ['state', 'history', 'read'].includes(body.endpoint)), 'inspection performs no writes or local Bot navigation')
  })
})

test('group and private rows use authorized member avatars, two-line summaries, selected state and accessible unread counts', async () => {
  const bots = ['Chief', 'Reviewer'].map((displayName, index) => ({ principalId: `bot:a:${index}`, displayName, kind: 'bot', homeInstanceId: 'a' }))
  const other = { principalId: 'human:b:peer', displayName: 'Peer', kind: 'human', homeInstanceId: 'b' }
  const group = { ...membership, unread: 4, info: { members: [...membership.info.members, ...bots, other] }, lastMessage: { summary: 'Ready for review', author: bots[0] } }
  const dm = { ...membership, kind: 'dm', title: 'ignored private title', conversationId: 'private', info: { members: [...membership.info.members, other] }, lastMessage: { summary: 'Hello across devices', author: other } }
  const snapshot = { ...state(), contacts: [...bots, other, { principalId: 'bot:private:secret', displayName: 'Private secret', kind: 'bot' }], conversations: [group, dm] }
  await pane({ snapshot }, async ({ doc }) => {
    const rows = doc.querySelectorAll('nav .bt-comm-conversation-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].querySelector('.bt-comm-conversation-name').textContent, 'Shared group')
    assert.equal(rows[0].querySelector('.bt-comm-conversation-preview').textContent, 'Chief: Ready for review')
    assert.deepEqual([...rows[0].querySelectorAll('[data-avatar-id]')].map(node => node.dataset.avatarId), group.info.members.map(person => person.principalId))
    assert.equal(rows[0].getAttribute('aria-label'), 'Shared group, Chief: Ready for review, 4 Unread', 'the button accessible name includes summary and exact unread count')
    assert.equal(rows[0].querySelector('.bt-comm-unread').textContent, '', 'the visible unread indicator is a dot')
    assert.equal(rows[1].querySelector('.bt-comm-conversation-name').textContent, 'Peer')
    assert.equal(rows[1].querySelector('.bt-comm-conversation-preview').textContent, 'Hello across devices')
    assert.deepEqual([...rows[1].querySelectorAll('[data-avatar-id]')].map(node => node.dataset.avatarId), [other.principalId])
    assert.equal(rows[1].querySelector('.bt-comm-unread'), null)
    await act(async () => rows[0].click())
    assert.equal(rows[0].getAttribute('aria-current'), 'page')
    assert.equal(rows[1].getAttribute('aria-current'), null)
    await act(async () => rows[1].click())
    assert.equal(rows[1].getAttribute('aria-current'), 'page')
    assert.doesNotMatch(doc.querySelector('nav').textContent, /Private secret/)
  })
})

test('unknown summary authors remain concise and cannot borrow names or avatars from another conversation', async () => {
  const removed = { principalId: 'bot:removed:long-principal-id', kind: 'bot', displayName: 'bot:removed:long-principal-id' }
  const snapshot = { ...state(), contacts: [{ ...removed, displayName: 'Private contact name' }], conversations: [{ ...membership, lastMessage: { summary: 'Authorized summary', author: removed } }] }
  await pane({ snapshot }, async ({ doc }) => {
    assert.equal(doc.querySelector('.bt-comm-conversation-preview').textContent, 'Authorized summary')
    assert.doesNotMatch(doc.querySelector('nav').textContent, /long-principal|Private contact name/)
    assert.equal(doc.querySelector('nav [data-avatar-id="bot:removed:long-principal-id"]'), null)
  })
})

test('routine failures, queues and reconciliation have no bottom console and activity stays scoped without automatic retries', async () => {
  const snapshot = { ...state(), error: 'FORBIDDEN', conversations: [membership, { ...membership, conversationId: 'other', title: 'Other group' }],
    outbox: [
      { id: 'failed-here', type: 'message.publish', state: 'failed', conversationId: 'group', principalId: 'human:a:owner', text: 'Preserved failed text', error: 'SPEAKING_FORBIDDEN' },
      { id: 'pending-here', type: 'message.publish', state: 'pending', conversationId: 'group', text: 'Pending text' },
      { id: 'old-foreign', type: 'invite', state: 'failed', conversationId: 'other', error: 'FORBIDDEN' },
      { id: 'bot-owned', type: 'invite', state: 'failed', conversationId: 'group', principalId: 'bot:a:private', error: 'SECRET_BOT_FAILURE' }],
    errors: [{ bindingId: 'here', conversationId: 'group', code: 'CURRENT_RECONCILE' }, { bindingId: 'elsewhere', conversationId: 'other', code: 'OTHER_RECONCILE' }],
    exportFailures: [{ messageId: 'export', conversationId: 'group', code: 'CURRENT_EXPORT' }] }
  await pane({ snapshot, handle: async body => { if (body.endpoint === 'send') throw Object.assign(new Error('denied'), { code: 'SPEAKING_FORBIDDEN' }); return {} } }, async ({ doc, click, edit, calls }) => {
    await click('Shared group')
    assert.equal(doc.querySelector('.bt-comm-feedback,.bt-comm-status-help,.bt-comm-activity,.bt-comm-toast'), null)
    assert.doesNotMatch(doc.querySelector('.bt-comm-main footer').textContent, /Send failed|Operation|not confirmed|CURRENT_RECONCILE|CURRENT_EXPORT|Queued messages|About message status/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-main').textContent, /FORBIDDEN|CURRENT_RECONCILE|CURRENT_EXPORT|OTHER_RECONCILE/)
    await click('Activity details')
    const activity = doc.querySelector('.bt-comm-activity')
    assert.match(activity.textContent, /Preserved failed text|Pending text/)
    assert.match(activity.textContent, /CURRENT_RECONCILE/); assert.match(activity.textContent, /CURRENT_EXPORT/)
    assert.doesNotMatch(activity.textContent, /OTHER_RECONCILE|SECRET_BOT_FAILURE|Operation failed/)
    assert.equal(calls.some(body => !['state', 'history', 'read'].includes(body.endpoint)), false)
    await click('Cancel')
    await edit(doc.querySelector('.bt-comm-main textarea'), 'Retained original intent')
    await click('Send message')
    assert.match(doc.querySelector('.bt-comm-toast').textContent, /read-only access/)
    assert.equal(doc.querySelector('.bt-comm-main textarea').value, 'Retained original intent')
    assert.ok([...doc.querySelectorAll('footer>button')].some(button => button.textContent === 'Retry same send'))
    await click('Dismiss notification')
    assert.equal(doc.querySelector('.bt-comm-toast'), null)
    assert.equal(calls.filter(body => body.endpoint === 'send').length, 1, 'dismiss and view never resend a rejected action')
  })
})

test('Hub management is independent and has no entry in client settings or pairing', async () => {
  const snapshot = { ...state(), hubUrl: 'wss://hub.example.test:3190/communication', managementAvailable: true, managementUrl: 'https://manage.example.test:9443/admin/' }
  await pane({ snapshot }, async ({ doc, calls, click }) => {
    assert.equal(doc.querySelector('.bt-comm-nav a.bt-comm-admin-link'), null)
    assert.doesNotMatch(doc.querySelector('.bt-comm-nav').textContent, /Open Hub management|Hub management/)
    await click('Personal settings')
    assert.equal(doc.querySelector('a.bt-comm-admin-link'), null)
    assert.doesNotMatch(doc.querySelector('.bt-comm-personal-settings').textContent, /Open Hub management|Hub management/)
    assert.equal(calls.some(body => /management|admin/.test(body.endpoint)), false)
  })
  for (const options of [{ managementAvailable: false, managementUrl: null }, { managementAvailable: true, managementUrl: 'https://user:password@hub.example.test/admin/' }, { managementAvailable: true, managementUrl: 'http://remote.example.test/admin/' }]) {
    await pane({ snapshot: { ...snapshot, ...options } }, async ({ doc, click }) => {
      assert.equal(doc.querySelector('a.bt-comm-admin-link'), null)
      await click('Personal settings')
      assert.doesNotMatch(doc.querySelector('.bt-comm-personal-settings').textContent, /Open Hub management|Hub management/)
      await click('Join Hub')
      assert.ok(doc.querySelector('[role=dialog][aria-label="Pairing guide"]'))
      assert.equal(doc.querySelector('a.bt-comm-admin-link'), null, 'no WSS-derived guessed management link in the guide')
    })
  }
})

test('background authorization failures stay quiet and revoked membership clears the visible authorized history', async () => {
  const snapshot = { ...state(), conversations: [{ ...membership, speakingMode: 'readOnly' }] }
  let deny = false
  const event = { type: 'message', conversationSeq: 1, serverAcceptedAt: '2026-11-04T00:00:00.000Z', message: { messageId: 'private-history', author: membership.info.members[0], content: { text: 'Previously authorized history' }, mentions: [] } }
  await pane({ snapshot, history: async () => { if (deny) throw Object.assign(new Error('persistent background denial'), { code: 'FORBIDDEN' }); return [event] } }, async ({ autoRefresh, doc, click, calls }) => {
    await click('Shared group')
    assert.match(doc.querySelector('.bt-comm-log').textContent, /Previously authorized history/)
    assert.equal(doc.querySelector('.bt-comm-toast'), null, 'ordinary read-only membership has no error toast')
    deny = true
    for (let index = 0; index < 3; index++) {
      snapshot.conversations[0].watermark += 1
      await autoRefresh()
      assert.equal(doc.querySelector('.bt-comm-toast'), null, 'persistent history rejection never replays a user notification')
      assert.doesNotMatch(doc.querySelector('.bt-comm-log').textContent, /Previously authorized history/)
    }
    await click('Activity details')
    assert.match(doc.querySelector('.bt-comm-activity').textContent, /permission for this group operation/)
    await click('Cancel')
    snapshot.conversations = []
    await autoRefresh()
    assert.equal(doc.querySelector('.bt-comm-main textarea'), null)
    assert.equal(doc.querySelector('.bt-comm-log article'), null)
    assert.doesNotMatch(doc.querySelector('.bt-comm-main').textContent, /Previously authorized history/)
    assert.equal(doc.querySelector('.bt-comm-toast'), null)
    assert.equal(calls.some(body => ['send', 'retry', 'accept'].includes(body.endpoint)), false)
  })
})

test('background read acknowledgement denial clears stale history without a toast or automatic send', async () => {
  const snapshot = { ...state(), conversations: [membership] }
  const event = { type: 'message', conversationSeq: 1, serverAcceptedAt: '2026-11-04T00:00:00.000Z', message: { messageId: 'read-denied', author: membership.info.members[0], content: { text: 'Read no longer authorized' }, mentions: [] } }
  await pane({ snapshot, history: [event], handleRead: async () => { throw Object.assign(new Error('read revoked'), { code: 'FORBIDDEN' }) } }, async ({ doc, calls, click }) => {
    await click('Shared group')
    assert.ok(calls.some(body => body.endpoint === 'read'))
    assert.equal(doc.querySelector('.bt-comm-toast'), null)
    assert.equal(doc.querySelector('.bt-comm-log article'), null)
    assert.equal(calls.some(body => body.endpoint === 'send'), false)
  })
})

test('publication diagnostics retain real safe errors and refresh local settings without repeating a save', async()=>{
  const snapshot=state();let mode='blocked',published=[],saves=0
  await pane({snapshot,handle:async body=>{
    if(body.endpoint==='available-bots')return {bots:[{id:'one',name:'One'}],publishedBotIds:published}
    if(body.endpoint==='user-code')throw Object.assign(new Error('DO_NOT_DISPLAY_RAW_FAILURE'),{code:'COMMUNICATION_UNAVAILABLE'})
    if(body.endpoint==='contact-requests'||body.endpoint==='contact-relations')return []
    if(body.endpoint==='publish-bots'){
      saves++
      if(mode==='blocked')throw Object.assign(new Error('DO_NOT_DISPLAY_RAW_CONFIG'),{code:'CONFIG_EDIT_OVERLAID',phase:'COMMUNICATION_CONFIG_WRITE_FAILED'})
      published=[...body.localBotIds];throw new TypeError('DO_NOT_DISPLAY_RAW_AFTER_SAVE')
    }
    assert.fail('Unexpected endpoint '+body.endpoint)
  }},async({ autoRefresh,doc,click,calls,button})=>{
    await click('Contacts')
    await act(async()=>[...doc.querySelectorAll('summary')].find(node=>node.textContent==='Published Bots').click())
    const publication = () => [...doc.querySelectorAll('.bt-comm-contact-manager fieldset')].find(node=>node.querySelector('legend').textContent==='Bots available to contacts').querySelector('[data-local-bot-id="one"]')
    assert.ok(publication(),'local publication state remains readable when Hub contact reads fail')
    await act(async()=>publication().click())
    await click('Save published Bots')
    assert.match(doc.querySelector('.bt-comm-contact-manager .bt-comm-error').textContent,/CONFIG_EDIT_OVERLAID.*COMMUNICATION_CONFIG_WRITE_FAILED/)
    assert.equal(saves,1);assert.doesNotMatch(doc.querySelector('.bt-comm-contact-manager').textContent,/DO_NOT_DISPLAY_RAW/)
    mode='ack-lost';await click('Save published Bots');assert.equal(saves,2)
    await autoRefresh()
    assert.equal(saves,2,'refresh performs reads only')
    assert.equal(publication().checked,true)
    assert.equal(button('Save published Bots').disabled,true,'effective config confirms the original save without another write')
    assert.equal(calls.filter(call=>call.endpoint==='publish-bots').length,2)
  })
})

// Every pane test above also runs without randomUUID, matching ordinary LAN HTTP.
test('legacy storage does not offer selecting the current Hub or infer its connection state',async()=>{
 await pane({snapshot:state(),handle:async body=>body.endpoint==='onboarding-storage'?{configured:true,hubId:'old-hub',url:'wss://synthetic.example.test/communication',status:'approved'}:{}},async({click,button,calls})=>{
  await click('Personal settings');await click('Join Hub')
  assert.equal(button('Select this Hub'),undefined)
  assert.equal(button('Disconnect this Hub'),undefined)
  assert.equal(button('Resume this Hub'),undefined)
  assert.equal(calls.some(call=>call.endpoint==='switch-hub'),false)
 })
})
test('missing secure randomness fails before sending and retains the composer text',async()=>{
 await pane({snapshot:{...state(),conversations:[membership]},cryptoSource:{}},async({click,doc,edit,calls})=>{
  await click('Shared group')
  const input=doc.querySelector('textarea[aria-label="Message"]')??doc.querySelector('footer textarea')
  await edit(input,'synthetic unsent text');await click('Send message')
  assert.equal(calls.some(call=>call.endpoint==='send'),false)
  assert.equal(input.value,'synthetic unsent text')
  assert.match(doc.body.textContent,/cannot create secure request identifiers/)
 })
})


test('top Contacts entry opens the directory directly and every management dialog has visible keyboard-safe exits', async () => {
  const snapshot = { ...state(), contacts: [{ principalId: 'human:b:owner', kind: 'human', displayName: 'Other person', homeInstanceId: 'b' }] }
  await pane({ snapshot, handle: async body => body.endpoint === 'user-code' ? { userCode: 'MY-CODE' } : body.endpoint === 'available-bots' ? { bots: [], publishedBotIds: [] } : body.endpoint === 'onboarding-storage' ? { enrollments: [] } : [] }, async ({ doc, dom, click, button, calls }) => {
    const trigger = button('Contacts')
    await act(async () => trigger.focus())
    await click('Contacts')
    assert.ok(doc.querySelector('.bt-comm-directory'))
    assert.ok(button('Close dialog'))
    assert.equal(button('Back to settings'), undefined, 'direct entry does not invent an ancestor')
    await click('Close dialog')
    assert.equal(doc.querySelector('.bt-comm-modal'), null)
    assert.equal(doc.activeElement, trigger)
    // Assistive-technology activation need not focus its target first.
    await click('Personal settings')
    assert.equal(button('Manage contacts'), undefined, 'Contacts has one dedicated toolbar entry')
    assert.equal(button('Add a device'), undefined)
    assert.equal(button('Refresh status'), undefined)
    await click('Join Hub')
    assert.ok(button('Back to settings')); assert.ok(button('Close dialog'))
    await click('Back to settings')
    assert.equal(doc.activeElement, button('Join Hub'))
    await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(doc.querySelector('.bt-comm-modal'), null)
    assert.equal(doc.activeElement.getAttribute('aria-label'), 'Personal settings')
    assert.equal(calls.some(call => ['dm', 'join-hub', 'request-contact'].includes(call.endpoint)), false)
  })
})


test('closing Contacts while a message conversation is opening prevents late navigation and duplicate clicks', async () => {
  let finish, created = false
  const person = { principalId: 'human:b:owner', kind: 'human', displayName: 'Other person', homeInstanceId: 'b' }
  const snapshot = { ...state(), contacts: [person] }
  await pane({ snapshot, getState: () => ({ ...snapshot, conversations: created ? [{ ...membership, conversationId: 'new-dm', kind: 'dm', title: '', info: { members: [person] } }] : [] }), handle: async body => {
    if (body.endpoint === 'dm') return new Promise(resolve => { finish = () => { created = true; resolve({ conversationId: 'new-dm' }) } })
    return body.endpoint === 'user-code' ? { userCode: 'MY-CODE' } : body.endpoint === 'available-bots' ? { bots: [], publishedBotIds: [] } : []
  } }, async ({ doc, click, calls }) => {
    await click('Contacts')
    const send = doc.querySelector('[aria-label="Message Other person"]')
    await act(async () => send.click())
    assert.equal(send.disabled, true)
    await act(async () => send.click())
    await click('Close dialog')
    await act(async () => finish())
    assert.equal(calls.filter(call => call.endpoint === 'dm').length, 1)
    assert.equal(doc.querySelector('.bt-comm-modal'), null)
    assert.equal(doc.querySelector('.bt-comm-conversation-row').getAttribute('aria-pressed'), 'false')
  })
})

for (const hiddenBy of ['panel', 'mode']) for (const reopenFirst of [false, true]) test(`hiding the workspace by ${hiddenBy} ${reopenFirst ? 'and reopening before' : 'until after'} a Contacts response preserves selection`, async () => {
  let finish, created = false
  const person = { principalId: 'human:b:owner', kind: 'human', displayName: 'Other person', homeInstanceId: 'b' }
  const dm = { ...membership, conversationId: 'new-dm', kind: 'dm', title: '', info: { members: [person] } }
  const snapshot = { ...state(), contacts: [person], conversations: [membership] }
  await pane({ snapshot, getState: () => ({ ...snapshot, conversations: created ? [membership, dm] : [membership] }), handle: async body => {
    if (body.endpoint === 'dm') return new Promise(resolve => { finish = () => { created = true; resolve({ conversationId: dm.conversationId }) } })
    return body.endpoint === 'user-code' ? { userCode: 'MY-CODE' } : body.endpoint === 'available-bots' ? { bots: [], publishedBotIds: [] } : []
  } }, async ({ doc, panel, surface, click, calls }) => {
    await click('Shared group'); await click('Contacts')
    await act(async () => doc.querySelector('[aria-label="Message Other person"]').click())
    const visibility = value => hiddenBy === 'panel' ? panel.set(value) : surface.set({ mode: value ? 'bot' : 'chat' })
    await act(async () => visibility(false))
    if (reopenFirst) await act(async () => visibility(true))
    await act(async () => finish())
    if (!reopenFirst) await act(async () => visibility(true))
    assert.equal(calls.filter(call => call.endpoint === 'dm').length, 1)
    assert.equal(doc.querySelector('[data-conversation-id="group"]').getAttribute('aria-pressed'), 'true')
    assert.equal(doc.querySelector('[data-conversation-id="new-dm"]').getAttribute('aria-pressed'), 'false')
    assert.equal(doc.querySelector('.bt-comm-modal').getAttribute('aria-label'), 'Manage contacts')
  })
})

test('failed reply reads recover automatically at an unchanged watermark without sending or reopening', async () => {
  const event = { type: 'message', conversationSeq: 1, serverAcceptedAt: '2026-11-04T00:00:00Z', message: { messageId: 'root', author: membership.info.members[0], content: { text: 'Synthetic reply root' }, mentions: [] } }
  let fail = true
  await pane({ snapshot: { ...state(), conversations: [membership] }, history: [event], handle: async body => {
    assert.equal(body.endpoint, 'thread')
    if (fail) throw Object.assign(Error('DO_NOT_DISPLAY_RAW_NETWORK_FAILURE'), { code: 'REQUEST_TIMEOUT' })
    return { conversationId: 'group', membershipEpoch: 'epoch', messageId: 'root', rootMessageId: 'root', watermark: 1, events: [event], hasMore: false }
  } }, async ({ doc, click, calls, autoRefresh }) => {
    await click('Shared group'); await click('View replies')
    assert.match(doc.querySelector('.bt-comm-thread').textContent, /unavailable.*retry automatically/)
    assert.doesNotMatch(doc.body.textContent, /DO_NOT_DISPLAY_RAW/)
    fail = false; await autoRefresh()
    assert.match(doc.querySelector('.bt-comm-thread-log').textContent, /Synthetic reply root/)
    assert.equal(calls.filter(call => call.endpoint === 'thread').length, 2)
    assert.equal(calls.some(call => ['send', 'retry', 'accept'].includes(call.endpoint)), false)
  })
})

test('automatic main-state failures announce stale status and recover without refresh controls or draft loss', async () => {
  const snapshot = { ...state(), conversations: [membership] }
  let fail = false
  await pane({ snapshot, getState: () => { if (fail) throw Object.assign(Error('DO_NOT_DISPLAY_RAW_STATUS_FAILURE'), { code: 'CONNECTION_LOST' }); return snapshot } }, async ({ doc, click, edit, calls, autoRefresh, button }) => {
    await click('Shared group'); await edit(doc.querySelector('footer textarea'), 'Preserve my draft')
    fail = true; await autoRefresh()
    assert.match(doc.querySelector('aside').textContent, /Status may be out of date/)
    assert.equal(doc.querySelector('[data-connected]').dataset.connected, 'false')
    assert.equal(button('Refresh status'), undefined)
    fail = false; await autoRefresh()
    assert.equal(doc.querySelector('[data-connected]').dataset.connected, 'true')
    assert.doesNotMatch(doc.querySelector('aside').textContent, /Status may be out of date/)
    assert.equal(doc.querySelector('footer textarea').value, 'Preserve my draft')
    await click('Activity details')
    assert.equal(button('Refresh status'), undefined)
    assert.equal(calls.some(call => ['send', 'retry'].includes(call.endpoint)), false)
  })
})

test('personal memory settings update and recover automatically without writing preferences', async () => {
  let localMemory = true, fail = false
  await pane({ snapshot: state(), handle: async body => {
    assert.equal(body.endpoint, 'memory-settings')
    if (fail) throw Object.assign(Error('Synthetic read failure'), { code: 'CONNECTION_LOST' })
    return { localMemory }
  } }, async ({ doc, click, calls, autoRefresh }) => {
    await click('Personal settings')
    const field = () => doc.querySelector('.bt-comm-personal-settings input[type=checkbox]')
    assert.equal(field().checked, true)
    localMemory = false; await autoRefresh()
    assert.equal(field().checked, false)
    fail = true; await autoRefresh()
    assert.match(doc.querySelector('.bt-comm-personal-settings').textContent, /Status may be out of date/)
    fail = false; await autoRefresh()
    assert.doesNotMatch(doc.querySelector('.bt-comm-personal-settings').textContent, /Status may be out of date/)
    assert.equal(calls.some(call => call.endpoint === 'set-memory-settings'), false)
  })
})


test('a fresh pending-reset document clears main and thread drafts before React hydrates either composer', async () => {
  const epoch = '00000000-0000-4000-8000-000000000001'
  const event = { type: 'message', conversationSeq: 1, serverAcceptedAt: '2026-11-04T00:00:00Z', message: { messageId: 'root', author: membership.info.members[0], content: { text: 'New reply target' }, mentions: [], replyToMessageId: null } }
  const threadKey = 'ds-bot:communication:thread:a:group:epoch:root'
  await pane({ snapshot: { ...state(), conversations: [membership] }, history: [event],
    storage: { 'ds-bot:federation-browser-epoch': 'pending:' + epoch, 'ds-bot:communication:selected': JSON.stringify('group'),
      'ds-bot:communication:drafts': JSON.stringify({ 'a:group': { text: 'old main text' }, 'old:other': { text: 'old hidden text' } }),
      'ds-bot:communication:attempts': JSON.stringify({ 'a:group': { text: 'old pending attempt' } }) },
    localStored: { [threadKey]: JSON.stringify({ text: 'old thread text', attempt: { conversationId: 'group', membershipEpoch: 'epoch', text: 'old thread attempt' } }) },
    handle: async body => body.endpoint === 'thread' ? { conversationId: 'group', membershipEpoch: 'epoch', messageId: 'root', rootMessageId: 'root', watermark: 1, events: [event], hasMore: false } : {},
  }, async ({ dom, doc, click, edit }) => {
    assert.equal(dom.window.sessionStorage.getItem('ds-bot:federation-browser-epoch'), epoch)
    assert.equal(dom.window.sessionStorage.getItem('ds-bot:communication:attempts'), null)
    assert.equal(dom.window.localStorage.getItem(threadKey), null)
    await click('Shared group')
    assert.equal(doc.querySelector('footer textarea').value, '')
    await edit(doc.querySelector('footer textarea'), 'New main text')
    const persisted = dom.window.sessionStorage.getItem('ds-bot:communication:drafts')
    assert.ok(persisted.includes('New main text')); assert.ok(!persisted.includes('old'))
    await act(async () => doc.querySelector('[data-message-id="root"] button[aria-label="Reply"]').click())
    assert.equal(doc.querySelector('.bt-comm-thread-composer textarea').value, '')
    await edit(doc.querySelector('.bt-comm-thread-composer textarea'), 'New thread text')
    assert.ok(dom.window.localStorage.getItem(threadKey).includes('New thread text'))
    assert.ok(!dom.window.localStorage.getItem(threadKey).includes('old'))
  })
})
