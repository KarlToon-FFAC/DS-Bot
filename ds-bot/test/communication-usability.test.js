import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createSource, updateLiveRoster } from '../src/client/sources.js'

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
  const panel = createSource(true), roster = createSource({ remoteHubEnabled: true, communicationEnabled: enabled, ready: true }), surface = createSource({ mode: 'bot' }), calls = []
  const request = async body => {
    calls.push(body)
    if (body.endpoint === 'state') return getState ? getState() : { ...snapshot, conversations: snapshot.conversations?.map(item => ({ ...item })) }
    if (body.endpoint === 'history') { const value = typeof history === 'function' ? await history(body) : history; return Array.isArray(value) ? { conversationId: body.conversationId, membershipEpoch: 'epoch', events: value } : value }
    if (body.endpoint === 'read') return handleRead(body)
    return handle(body)
  }
  let root = createRoot(dom.window.document.getElementById('root'))
  const doc = dom.window.document
  const button = label => [...([...doc.querySelectorAll('dialog[open]:not([data-closing=true])')].at(-1) ?? doc).querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
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
    await check({ dom, doc, panel, surface, roster, calls, button, click, edit, autoRefresh, remount: async () => {
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

test('a same-revision Hub configuration update starts live connection checks without remounting the page', async () => {
  let snapshot = { ...state(), enabled: false, connected: false }
  await pane({ enabled: false, getState: () => snapshot }, async ({ doc, roster, calls, button, autoRefresh }) => {
    const label = () => doc.querySelector('.bt-comm-connection-label')
    assert.equal(label().textContent, 'Not configured')
    assert.equal(calls.some(call => call.endpoint === 'state'), false)
    await act(async () => {
      snapshot = { ...state(), enabled: true, hubId: 'hub-a' }
      updateLiveRoster(roster, { unchanged: true, communicationEnabled: true, communicationHubId: 'hub-a' })
    })
    assert.equal(label().textContent, 'Connected to Hub')
    assert.equal(label().dataset.connected, 'true')
    assert.equal(button('Contacts').disabled, false)
    snapshot = { ...snapshot, connected: false }
    await autoRefresh()
    assert.equal(label().dataset.connected, 'false')
    snapshot = { ...snapshot, connected: true }
    await autoRefresh()
    assert.equal(label().textContent, 'Connected to Hub')
    await act(async () => updateLiveRoster(roster, { unchanged: true, communicationEnabled: false, communicationHubId: null }))
    assert.equal(label().textContent, 'Not configured')
    assert.equal(label().dataset.connected, 'false')
    assert.equal(button('Contacts').disabled, true)
  })
})

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
      assert.equal(calls.some(call => !['state', 'history', 'read', 'avatar', 'contact-requests'].includes(call.endpoint)), false, 'restoration performs no membership or message mutation')
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
  const hub = {version:2,trustFingerprint:'a'.repeat(64), hubId: 'onboarding-test', url: 'wss://hub.example.test/communication' }, storage = { defaultProvider: 'test', encryptedByDefault: false }
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
    assert.ok(button('Withdraw request'))
    assert.equal(button('Forget this Hub'),undefined)
    assert.equal(Boolean(doc.querySelector('[aria-label="Hub code"]')),false)
    assert.match(doc.querySelector('.bt-comm-error').textContent, /CONNECTION_LOST.*ENROLLMENT_PROOF_FAILED/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-error').textContent, /DO_NOT_DISPLAY_RAW_FAILURE/)
    assert.equal(button('Confirm and request access'),undefined)
    assert.equal(calls.filter(call => call.endpoint === 'hub-join-status').length, 0)
    await autoRefresh()
    assert.equal(calls.filter(call => call.endpoint === 'join-hub').length, 1)
    assert.match(doc.querySelector('.bt-comm-onboarding').textContent, /pending/)
    absent = true; await autoRefresh()
    assert.equal(button('Withdraw request').disabled,false,'missing remote requests remain independently withdrawable')
    assert.equal(calls.filter(call => call.endpoint === 'join-hub').length, 1)
  })
})

test('an unreadable local request after an ambiguous join keeps submission blocked until local status is recovered', async () => {
  const storage = { defaultProvider: 'test' }, hub = {version:2,trustFingerprint:'a'.repeat(64), hubId: 'unreadable-test', url: 'wss://hub.example.test/communication' }
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

test('floating replies show chronological messages with parent quotes and preserve reply targets and read-only controls', async () => {
  const snapshot = { ...state(), conversations: [{ ...membership }] }
  const events = ['Root', 'Child', 'Another branch', 'Late deep reply'].map((text, i) => ({ type: 'message', conversationSeq: i + 1, serverAcceptedAt: '2026-11-04T00:00:00Z', message: { messageId: `m${i}`, author: membership.info.members[0], content: { text }, mentions: [], replyToMessageId: i === 3 ? 'm1' : i ? 'm0' : null } }))
  await pane({ snapshot, history: events, handle: async body => body.endpoint === 'thread' ? { conversationId: 'group', membershipEpoch: 'epoch', messageId: body.messageId, rootMessageId: 'm0', watermark: 4, events, hasMore: false } : {} }, async ({ autoRefresh, doc, click, edit, calls }) => {
    await click('Shared group')
    await click('View replies')
    assert.equal(doc.querySelectorAll('.bt-comm-thread-log article').length, 4)
    assert.deepEqual([...doc.querySelectorAll('.bt-comm-thread-log article')].map(node=>node.dataset.threadMessageId),['m0','m1','m2','m3'])
    assert.equal(doc.querySelectorAll('.bt-comm-thread-parent').length,3)
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

test('message hover icons copy without sending and show the root and sibling replies while retaining the selected reply target',async()=>{
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
  assert.equal(doc.querySelectorAll('.bt-comm-thread-log article').length,4)
  assert.ok(doc.querySelector('[data-thread-message-id="m0"]'))
  assert.ok(doc.querySelector('[data-thread-message-id="m3"]'))
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

test('one invitation detail dialog includes all targets from the exact same inviter and accepts each once', async () => {
  const snapshot=state(), accepted=[]
  snapshot.invites=['human:a:owner','bot:a:one','bot:a:two'].map((principalId,index)=>({inviteId:`invite-${index}`,conversationId:'remote-group',title:'Remote review',principalId,principalName:`Target ${index}`,inviterPrincipalId:'human:b:buddy',inviterName:'Buddy',inviterIpAddress:'192.0.2.20'}))
  await pane({snapshot,handle:async body=>{assert.equal(body.endpoint,'accept');accepted.push(body);snapshot.invites=snapshot.invites.filter(item=>item.inviteId!==body.inviteId);return {conversationId:'remote-group'}}},async({doc,click})=>{
    assert.equal(doc.querySelectorAll('[data-invitation-group]').length,1)
    assert.equal([...doc.querySelectorAll('.bt-comm-nav button')].some(node=>node.textContent==='Accept invitation'),false)
    await act(async()=>doc.querySelector('[data-invitation-group]').click())
    const dialog=doc.querySelector('[aria-label="Invitation details"]')
    assert.match(dialog.textContent,/Buddy/);assert.match(dialog.textContent,/192.0.2.20/);assert.equal(dialog.querySelectorAll('li').length,3)
    await click('Accept invitation')
    assert.equal(accepted.length,3);assert.equal(accepted[0].recipientPrincipalId,'human:a:owner')
    assert.equal(new Set(accepted.map(item=>item.operationId)).size,3)
    assert.equal(doc.querySelectorAll('[data-invitation-group]').length,0)
  })
})

test('group creation selects only Bots, shows contact and IP together, and deduplicates the automatic owner invite', async () => {
  const snapshot=state(), invited=[]
  snapshot.contacts=[{principalId:'human:b:buddy',displayName:'Buddy',kind:'human',homeInstanceId:'b',ipAddress:'192.0.2.20'},...['one','two'].map(id=>({principalId:`bot:b:${id}`,kind:'bot',displayName:id,ownerPrincipalId:'human:b:buddy',homeInstanceId:'b'}))]
  await pane({snapshot,handle:async body=>{if(body.endpoint==='create-group')return {conversationId:'created'};assert.equal(body.endpoint,'invite');invited.push(body.inviteePrincipalId);return {}}},async({doc,click,edit})=>{
    await click('New group');await edit(doc.querySelector('[aria-label="Group name"]'),'Review')
    const heading=[...doc.querySelectorAll('.bt-comm-group-contact-heading')].find(node=>node.textContent.includes('Buddy'))
    assert.match(heading.textContent,/192.0.2.20/);assert.equal(heading.querySelector('input'),null)
    const boxes=doc.querySelectorAll('.bt-comm-group-choices input[type=checkbox]');assert.equal(boxes.length,2)
    for(const box of boxes)await act(async()=>box.click())
    await click('Create and invite')
    assert.deepEqual(invited,['bot:b:one','bot:b:two'])
  })
})

test('partial invitations preserve the created group and never create another group or silently retry invitations', async () => {
  const snapshot = state(), invitations = []
  snapshot.contacts = ['human:b:person', 'bot:b:chief'].map((principalId, index) => ({ principalId, displayName: index ? 'Chief' : 'Person', homeInstanceId: 'b', instanceLabel: 'Other device', kind: index ? 'bot' : 'human', ownerPrincipalId: 'human:b:person' }))
  snapshot.contacts.push({...snapshot.contacts[1],principalId:'bot:b:second',displayName:'Second'})
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
    await click('Close member settings')
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


test('automatic device setup stays available without the manual configuration guide', async () => {
  for (const enabled of [false, true]) {
    await pane({ enabled, snapshot: state(), handle: async body => { if(body.endpoint==='contact-requests')return [];if(body.endpoint==='work-approval-settings')return {remoteWorkApproval:'inherit'};if(body.endpoint==='memory-settings')return {localMemory:true};if(body.endpoint==='human-profile-info')return {principalId:'human:a:owner',publicProfile:{headline:'',summary:'',expertise:[],languages:[],version:0,updatedAt:null}};assert.equal(body.endpoint, 'onboarding-storage'); return { storage: { defaultProvider: 'owner-acl-plaintext', encryptedByDefault: false, agentIsolation: false }, enrollments: [] } } }, async ({ doc, dom, calls, click, panel }) => {
      await click('Personal settings')
      await click('Join Hub')
      const setup = doc.querySelector('.bt-comm-modal[aria-label="Add a device"]')
      assert.ok(setup)
      assert.ok(setup.querySelector('[aria-label="Hub code"]'))
      assert.ok([...setup.querySelectorAll('button')].some(item => item.textContent === 'Review Hub'))
      assert.equal(setup.querySelector('.bt-comm-manual-guide'), null)
      assert.equal(setup.querySelector('[aria-label="Hub configuration example"]'), null)
      assert.equal(setup.querySelector('[aria-label="Device configuration example"]'), null)
      assert.doesNotMatch(setup.textContent, /Manual configuration guide|publishedBotIds|credentialEnv/)
      assert.equal(calls.filter(call => !['state', 'onboarding-storage', 'memory-settings', 'human-profile-info', 'user-code', 'available-bots', 'work-approval-settings', 'contact-requests'].includes(call.endpoint)).length, 0, JSON.stringify(calls.map(call => call.endpoint)))
      await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      assert.equal(doc.querySelector('.bt-comm-modal'), null)
      assert.equal(panel.getSnapshot(), true)
      assert.equal(calls.filter(call => !['state', 'onboarding-storage', 'memory-settings', 'human-profile-info', 'user-code', 'available-bots', 'work-approval-settings', 'contact-requests'].includes(call.endpoint)).length, 0, JSON.stringify(calls.map(call => call.endpoint)))
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
    if (body.endpoint === 'contact-requests') return []
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
    await act(async () => doc.querySelector('.bt-comm-members>summary').click())
    const drawer = doc.querySelector('[role="complementary"][aria-label="Group members and receiving rules"]')
    assert.match(drawer.textContent, /Both Bot modes can explicitly reply to their current input or finish without a reply/)
    assert.match(drawer.textContent, /Reply-only Bots cannot initiate messages/)
    assert.match(drawer.textContent, /Active Bots may also initiate with tools/)
    assert.match(drawer.textContent, /Explicit follow-ups stay within the server’s finite delegation limit/)
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
    snapshot.conversations = [{ ...current, title: body.title, routingMode: body.routing.mode, defaultBotPrincipalIds: body.routing.defaultBotPrincipalIds, membershipVersion: 2, info: { members: current.info.members.map(person => person.principalId === bot.principalId ? { ...person, ...body.policies[0] } : person) } }]
    return { updated: true, conversationId: 'group', membershipVersion: 2 }
  } }, async ({ doc, click, edit, calls, button }) => {
    await click('Shared group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    const save = () => doc.querySelector('[aria-label="Save group settings"]')
    assert.equal(save().disabled, true)
    assert.equal([...doc.querySelectorAll('[role="complementary"][aria-label="Group members and receiving rules"] button')].filter(node => node.textContent.startsWith('Save')).length, 1)
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Atomic title')
    await edit(doc.querySelector('[data-principal-id="bot:a:one"] select[aria-label="Speaking permission"]'), 'active')
    await edit(doc.querySelector('select[aria-label="Receiving rule"]'), 'admin')
    await click('Choose receiving Bots')
    await act(async () => doc.querySelector('input[data-receiving-bot]').click())
    await click('Use selected Bots')
    assert.equal(save().dataset.dirty, 'true')
    assert.equal(calls.some(call => ['policy', 'routing', 'configure-group'].includes(call.endpoint)), false)
    await click('Save')
    const sent = calls.find(call => call.endpoint === 'save-settings')
    assert.equal(sent.title, 'Atomic title')
    assert.equal(sent.expectedVersion, 1)
    assert.equal(sent.membershipEpoch, 'epoch')
    assert.deepEqual(Array.from(sent.routing.defaultBotPrincipalIds),[bot.principalId])
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
    assert.match(doc.querySelector('[role="complementary"][aria-label="Group members and receiving rules"] [role=alert]').textContent, /Group settings changed/)
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
    if (body.endpoint === 'contact-requests') return []
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
    await click('Close member settings')
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
    const drawer = doc.querySelector('[role="complementary"][aria-label="Group members and receiving rules"]')
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
    if (body.endpoint === 'contact-requests') return []
    versions.push(body.expectedVersion); unavailable = true
    return { updated: true, conversationId: 'group', membershipVersion: body.expectedVersion + 1 }
  } }, async ({ doc, click, edit }) => {
    await click('Shared group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Committed')
    await click('Save')
    assert.equal(doc.querySelector('[aria-label="Save group settings"]').disabled, true)
    assert.equal(doc.querySelector('[role="complementary"][aria-label="Group members and receiving rules"] [role=alert]'), null)
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
    assert.ok(calls.every(body => ['state', 'history', 'read', 'participant-profile', 'contact-requests'].includes(body.endpoint)), 'inspection performs no writes or local Bot navigation')
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
    assert.equal(rows[0].querySelector('.bt-comm-unread').textContent, '4', 'the visible badge shows the unread message count')
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
  await pane({ snapshot, handle: async body => { if (body.endpoint === 'send') throw Object.assign(new Error('uncertain'), { code: 'REQUEST_TIMEOUT' }); return {} } }, async ({ doc, click, edit, calls }) => {
    await click('Shared group')
    assert.equal(doc.querySelector('.bt-comm-feedback,.bt-comm-status-help,.bt-comm-activity,.bt-comm-toast'), null)
    assert.doesNotMatch(doc.querySelector('.bt-comm-main footer').textContent, /Send failed|Operation|not confirmed|CURRENT_RECONCILE|CURRENT_EXPORT|Queued messages|About message status/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-main').textContent, /FORBIDDEN|CURRENT_RECONCILE|CURRENT_EXPORT|OTHER_RECONCILE/)
    await click('Activity details')
    const activity = doc.querySelector('.bt-comm-activity')
    assert.match(activity.textContent, /Preserved failed text|Pending text/)
    assert.match(activity.textContent, /CURRENT_RECONCILE/); assert.match(activity.textContent, /CURRENT_EXPORT/)
    assert.doesNotMatch(activity.textContent, /OTHER_RECONCILE|SECRET_BOT_FAILURE|Operation failed/)
    assert.equal(calls.some(body => !['state', 'history', 'read', 'participant-profile', 'contact-requests'].includes(body.endpoint)), false)
    await click('Cancel')
    await edit(doc.querySelector('.bt-comm-main textarea'), 'Retained original intent')
    await click('Send message')
    assert.match(doc.querySelector('.bt-comm-toast').textContent, /timed out/)
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
      assert.ok(doc.querySelector('[role=dialog][aria-label="Add a device"]'))
      assert.equal(doc.querySelector('a.bt-comm-admin-link'), null, 'no WSS-derived guessed management link in device setup')
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
    await click('Personal settings')
    await act(async()=>[...doc.querySelectorAll('summary')].find(node=>node.textContent==='Published Bots').click())
    const publication = () => [...doc.querySelectorAll('.bt-comm-own-profile fieldset')].find(node=>node.querySelector('legend').textContent==='Bots available to contacts').querySelector('[data-local-bot-id="one"]')
    assert.ok(publication(),'local publication state remains readable when Hub contact reads fail')
    await act(async()=>publication().click())
    await click('Save published Bots')
    assert.match(doc.querySelector('.bt-comm-own-profile .bt-comm-error').textContent,/CONFIG_EDIT_OVERLAID.*COMMUNICATION_CONFIG_WRITE_FAILED/)
    assert.equal(saves,1);assert.doesNotMatch(doc.querySelector('.bt-comm-own-profile').textContent,/DO_NOT_DISPLAY_RAW/)
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
    if(body.endpoint==='user-code')return {userCode:'SYNTHETIC'}
    if(body.endpoint==='available-bots')return {bots:[],publishedBotIds:[]}
    if(body.endpoint==='work-approval-settings')return {remoteWorkApproval:'inherit'}
    assert.equal(body.endpoint, 'memory-settings')
    if (fail) throw Object.assign(Error('Synthetic read failure'), { code: 'CONNECTION_LOST' })
    return { localMemory }
  } }, async ({ doc, click, calls, autoRefresh }) => {
    await click('Personal settings')
    const field = () => [...doc.querySelectorAll('.bt-comm-personal-settings label')].find(node=>node.textContent.includes('Allow each Bot to use its own local memory')).querySelector('input')
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


test('member details show the canonical owning contact and full public Bot profile without private fields',async()=>{
 const bot={principalId:'bot:b:coder',kind:'bot',displayName:'Coder',ownerPrincipalId:'human:b:buddy',publicProfile:{headline:'Short preview',truncated:true}},owner={principalId:'human:b:buddy',kind:'human',displayName:'Buddy',ipAddress:'192.0.2.20'}
 const snapshot={...state(),contacts:[bot,owner],conversations:[{...membership,kind:'dm',title:'Private',info:{members:[membership.info.members[0],bot]}}]}
 await pane({snapshot,handle:async body=>{assert.equal(body.endpoint,'participant-profile');return {principalId:bot.principalId,publicProfile:{headline:'Testing expert',summary:'Complete public profile',expertise:['Regression'],instructions:'PRIVATE_CANARY_DO_NOT_RENDER',version:2}}}},async({doc,click})=>{
  await click('Coder');await act(async()=>doc.querySelector('.bt-comm-title-pill').click())
  const dialog=doc.querySelector('[aria-label="Participant information"]')
  assert.match(dialog.textContent,/From contact.*Buddy/s);assert.match(dialog.textContent,/192.0.2.20/)
  assert.match(dialog.textContent,/Testing expert.*Complete public profile.*Regression/s)
  assert.doesNotMatch(dialog.textContent,/PRIVATE_CANARY/)
 })
})

test('Bot-to-Bot records have a dedicated read-only conversation without a Human membership or Human read ACK',async()=>{
 const members=[{principalId:'bot:a:worker',kind:'bot',displayName:'Worker'},{principalId:'bot:b:expert',kind:'bot',displayName:'Expert'}]
 const snapshot={...state(),botConversations:[{conversationId:'bot-only-dm',kind:'dm',archive:true,viewerBotId:'worker',viewerPrincipalId:members[0].principalId,membershipEpoch:'private-epoch',joinSeq:1,watermark:1,info:{members}}]}
 const event={type:'message',conversationSeq:1,serverAcceptedAt:'2026-11-06T00:00:00Z',message:{messageId:'bot-note',author:members[1],content:{text:'Recorded expert advice'},mentions:[]}}
 await pane({snapshot,handle:async body=>{assert.equal(body.endpoint,'bot-dm-history');assert.equal(body.localBotId,'worker');assert.equal(body.membershipEpoch,'private-epoch');return {conversationId:'bot-only-dm',membershipEpoch:'private-epoch',events:[event]}}},async({doc,calls})=>{
  await act(async()=>doc.querySelector('[aria-label="Bot private chats"] [data-conversation-id]').click())
  assert.match(doc.querySelector('.bt-comm-log').textContent,/Recorded expert advice/)
  assert.match(doc.querySelector('.bt-comm-archive-notice').textContent,/Read-only/)
  assert.equal(doc.querySelector('textarea[aria-label="Communication message"]'),null)
  assert.ok(!calls.some(body=>['send','read','accept'].includes(body.endpoint)))
 })
})

test('Hub forgetting is a separate top-layer confirmation, cancellation never mutates, and errors stay beside the confirmation',async()=>{
 const hub={hubId:'saved-hub',url:'wss://synthetic.example.test/communication',status:'approved',departed:false}
 await pane({snapshot:state(),handle:async body=>{
  if(body.endpoint==='onboarding-storage')return {enrollments:[hub]}
  if(body.endpoint==='forget-hub')throw Object.assign(new Error('synthetic'),{code:'HUB_SELECTION_CHANGED'})
  return {}
 }},async({dom,doc,click,calls})=>{
  await click('Personal settings');await click('Join Hub');await click('Forget this Hub')
  const dialog=doc.querySelector('dialog[aria-label="Forget this Hub"]')
  assert.equal(dialog.parentElement,doc.body);assert.equal(dialog.open,true)
  assert.ok(dialog.contains(doc.activeElement));assert.ok(dialog.querySelector('.bt-comm-operation-footer'))
  await click('Cancel');assert.equal(calls.some(body=>body.endpoint==='forget-hub'),false)
  await click('Forget this Hub');await click('Confirm forgetting')
  assert.ok(dialog.querySelector('[role=alert]'))
  assert.equal(calls.filter(body=>body.endpoint==='forget-hub').length,1)
  await act(async()=>doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  assert.ok(doc.querySelector('[aria-label="Add a device"]'),'Escape closes only the confirmation')
 })
})

test('private chats and Bot DM records archive into one separate collection, stay hidden on refresh, and restore without sending',async()=>{
 const other={principalId:'human:b:buddy',displayName:'Buddy',kind:'human'}
 const dm={...membership,conversationId:'human-private',kind:'dm',info:{members:[membership.info.members[0],other]}}
 const botRecord={...dm,conversationId:'bot-private',archive:true,viewerBotId:'worker',viewerPrincipalId:'bot:a:worker',info:{members:[{principalId:'bot:a:worker',displayName:'Worker',kind:'bot'},{principalId:'bot:b:expert',displayName:'Expert',kind:'bot'}]}}
 let snapshot={...state(),conversationPreferencesScope:'local-scope',archivedConversationIds:[],conversations:[membership,dm],botConversations:[botRecord]}
 await pane({getState:()=>snapshot,handle:async body=>{
  if(body.endpoint==='set-conversation-archived'){
   assert.equal(body.expectedScope,'local-scope');assert.equal(body.membershipEpoch,'epoch')
   const ids=new Set(snapshot.archivedConversationIds);if(body.archived)ids.add(body.conversationId);else ids.delete(body.conversationId)
   snapshot={...snapshot,archivedConversationIds:[...ids]};return {archivedConversationIds:[...ids]}
  }
  if(body.endpoint==='bot-dm-history')return {conversationId:'bot-private',events:[]}
  return {}
 }},async({doc,click,calls,autoRefresh,remount})=>{
  await click('Buddy');await click('Archive private chat')
  assert.equal(doc.querySelector('nav[aria-label="Communication conversations"] [data-conversation-id="human-private"]'),null)
  await click('Worker ↔ Expert');await click('Archive private chat')
  assert.equal(doc.querySelector('nav[aria-label="Bot private chats"]'),null)
  await autoRefresh();await remount();await click('Archived private chats')
  const dialog=doc.querySelector('[aria-label="Archived private chats"][role=dialog]')
  assert.equal(dialog.querySelectorAll('.bt-comm-archive-row').length,2)
  await click('Restore private chat Buddy');await click('Cancel')
  assert.ok(doc.querySelector('nav [data-conversation-id="human-private"]'))
  assert.ok(doc.querySelector('nav [data-conversation-id="group"]'),'groups remain visible')
  assert.equal(calls.filter(body=>body.endpoint==='set-conversation-archived'&&body.localBotId==='worker').length,1)
  assert.ok(!calls.some(body=>['send','remove','accept','dissolve'].includes(body.endpoint)))
 })
})

test('group members are compact contact rows with nested Bots and invitation/removal each open their own dialog',async()=>{
 const buddy={principalId:'human:b:buddy',displayName:'Buddy',kind:'human',role:'member',speakingMode:'readOnly'}
 const bot={principalId:'bot:b:tester',displayName:'Tester',kind:'bot',role:'member',speakingMode:'passive',ownerPrincipalId:buddy.principalId}
 const extra={...bot,principalId:'bot:b:extra',displayName:'Extra'}
 const snapshot={...state(),contacts:[buddy,bot,extra],conversations:[{...membership,info:{members:[...membership.info.members,buddy,bot]}}]}
 let finish
 await pane({snapshot,handle:body=>body.endpoint==='invite'?new Promise(resolve=>{finish=resolve}):body.endpoint==='members'?{members:snapshot.conversations[0].info.members,membershipVersion:1}:{}},async({doc,click,calls})=>{
  await click('Shared group');await click('View conversation details')
  const group=doc.querySelector('[role="complementary"][aria-label="Group members and receiving rules"]')
  assert.ok(doc.querySelector('.bt-comm-main').contains(group))
  const contact=group.querySelector('[data-member-contact="human:b:buddy"]'),row=contact.querySelector('[data-principal-id="bot:b:tester"]')
  assert.ok(contact.querySelector('.bt-comm-member-bots').contains(row));assert.ok(row.querySelector('[aria-label="Speaking permission"]'))
  assert.ok(contact.querySelector('[data-principal-id="human:b:buddy"]'))
  assert.ok(row.querySelector('[aria-label="Speaking permission"]'))
  await click('Remove from group');assert.ok(doc.querySelector('dialog[aria-label="Remove from group"]'))
  assert.equal(calls.some(body=>body.endpoint==='remove'),false);await click('Cancel')
  await click('Invite participant')
  const invite=doc.querySelector('dialog[aria-label="Invite participant"]');assert.equal(invite.parentElement,doc.body)
  await act(async()=>invite.querySelector('[aria-label="Invite Extra"]').click());await click('Invite')
  assert.equal(calls.filter(body=>body.endpoint==='invite').length,1);assert.equal([...invite.querySelectorAll('button')].find(node=>node.textContent==='Invite').disabled,true)
  await act(async()=>finish({joined:true}));assert.equal(calls.find(body=>body.endpoint==='invite').inviteePrincipalId,extra.principalId)
  assert.ok(group.isConnected)
  await click('Close member settings');assert.equal(doc.activeElement,doc.querySelector('.bt-comm-title-pill'))
 })
})

test('UNKNOWN_MENTION after Enter preserves the exact Chinese draft, releases editing and navigation, and uses a new ID after correction',async()=>{
 const beta={principalId:'bot:b:beta',displayName:'贝塔',kind:'bot'}
 const snapshot={...state(),contacts:[beta],conversations:[{...membership,info:{members:[...membership.info.members,beta]}},{...membership,conversationId:'other',title:'Other group'}]}
 let reject=true
 await pane({snapshot,handle:async body=>{
  if(body.endpoint==='send'&&reject)throw Object.assign(new Error('synthetic'),{code:'UNKNOWN_MENTION'})
  return {}
 }},async({dom,doc,click,edit,calls,remount})=>{
  await click('Shared group')
  const text='@贝塔 你收到@你的消息了吗',input=()=>doc.querySelector('textarea[aria-label="Communication message"]')
  await edit(input(),text)
  await act(async()=>input().dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.equal(input().value,text);assert.equal(input().disabled,false)
  assert.match(doc.querySelector('.bt-comm-toast').textContent,/UNKNOWN_MENTION/)
  await click('Other group');await click('Shared group');await remount()
  assert.equal(input().value,text);assert.equal(input().disabled,false)
  await click('Personal settings');await click('Close dialog')
  reject=false;await edit(input(),'@贝塔 已修正')
  await click('Send message')
  const sends=calls.filter(body=>body.endpoint==='send')
  assert.equal(sends.length,2);assert.notEqual(sends[0].messageId,sends[1].messageId)
  assert.equal(input().value,'');assert.equal(input().disabled,false)
 })
})

test('right member sidebar keeps inline controls and opens the canonical full profile from its final arrow',async()=>{
 const buddy={principalId:'human:b:buddy',displayName:'Buddy',kind:'human',role:'member',speakingMode:'readOnly'}
 const bot={principalId:'bot:b:expert',displayName:'Expert',kind:'bot',ownerPrincipalId:buddy.principalId,role:'member',speakingMode:'passive'}
 await pane({snapshot:{...state(),contacts:[buddy,bot],conversations:[{...membership,info:{members:[...membership.info.members,buddy,bot]}}]},handle:async body=>body.endpoint==='participant-profile'?{principalId:bot.principalId,publicProfile:{headline:'Testing specialist',summary:'Background and detailed experience',expertise:['Regression','Browser automation'],version:1}}:{}},async({doc,click,calls})=>{
  await click('Shared group');await click('View conversation details')
  const panel=doc.querySelector('[role="complementary"]'),row=panel.querySelector('[data-principal-id="bot:b:expert"]')
  assert.ok(panel.closest('.bt-comm-main'))
  assert.ok(row.querySelector('.bt-comm-member-actions select[aria-label="Group role"]'))
  assert.ok(row.querySelector('.bt-comm-member-actions select[aria-label="Speaking permission"]'))
  await act(async()=>row.querySelector('[aria-label="View participant profile"]').click())
  const profile=doc.querySelector('[aria-label="Participant information"]')
  assert.match(profile.textContent,/Buddy.*Testing specialist.*Background and detailed experience.*Regression.*Browser automation/s)
  assert.equal(calls.find(body=>body.endpoint==='participant-profile').targetPrincipalId,bot.principalId)
  await click('Close dialog')
  assert.ok(panel.isConnected);assert.equal(doc.activeElement,row.querySelector('[aria-label="View participant profile"]'))
 })
})

test('retired group authors remain identifiable and inspectable without appearing in active member controls or mention choices',async()=>{
 const old={principalId:'bot:b:old',displayName:'Tester',kind:'bot',retired:true,retiredAt:'2026-11-09T00:00:00Z'}
 const snapshot={...state(),conversations:[{...membership,info:{...membership.info,formerMembers:[old]}}]}
 const history=[{type:'message',conversationSeq:1,message:{messageId:'old-message',author:old,content:{text:'Retained old answer'},mentions:[]}}]
 await pane({snapshot,history,handle:async body=>body.endpoint==='participant-profile'?{principalId:old.principalId,publicProfile:{headline:'Testing specialist',version:1}}:{}},async({doc,click})=>{
  await click('Shared group')
  assert.match(doc.querySelector('[data-message-id="old-message"]').textContent,/Tester.*Bot no longer exists/)
  await click('View conversation details')
  const group=doc.querySelector('[role=complementary]')
  assert.equal(group.querySelector('[data-principal-id="bot:b:old"]'),null)
  const details=[...group.querySelectorAll('details')].find(node=>node.querySelector('summary')?.textContent==='Former Bots')
  assert.ok(details)
  await act(async()=>{details.open=true;details.querySelector('button').click()})
  const card=doc.querySelector('[role=dialog][aria-label="Participant information"]')
  assert.match(card.textContent,/Bot no longer exists/);assert.match(card.textContent,/bot:b:old/)
 })
})

test('a private chat with a retired Bot stays readable and cannot display a send composer',async()=>{
 const old={principalId:'bot:b:old',displayName:'Tester',kind:'bot',retired:true}
 const snapshot={...state(),conversations:[{...membership,kind:'dm',info:{kind:'dm',members:[...membership.info.members,old]}}]}
 await pane({snapshot,history:[{type:'message',conversationSeq:1,message:{messageId:'old-message',author:old,content:{text:'Old private answer'},mentions:[]}}]},async({doc})=>{
  await act(async()=>doc.querySelector('[data-conversation-id="group"]').click())
  assert.match(doc.querySelector('.bt-comm-main').textContent,/Old private answer/)
  assert.match(doc.querySelector('.bt-comm-main').textContent,/This Bot identity no longer exists/)
  assert.equal(doc.querySelector('.bt-comm-main>footer'),null)
 })
})

test('connection status names version incompatibility and the concrete upgrade reason instead of only Offline',async()=>{
 for(const code of ['BOT_PUBLICATION_MIGRATION_REQUIRED','BOUNDED_COLLABORATION_REQUIRED','EXPLICIT_ACTIVATION_REQUIRED','UNSUPPORTED_CAPABILITY']){
  await pane({snapshot:{...state(),connected:false,error:code}},async({doc})=>{
   const connection=doc.querySelector('.bt-comm-connection')
   assert.equal(connection.querySelector('.bt-comm-connection-label').textContent,'Client and Hub versions are incompatible')
   assert.match(connection.textContent,new RegExp(code));assert.match(connection.textContent,/Update the client or Hub/)
   assert.match(connection.textContent,/Version not reported/)
  })
 }
})

test('compatible version differences and subsequent matching versions update live without reconnect instructions for an outage',async()=>{
 let snapshot={...state(),connected:true,compatibility:{clientVersion:'0.2.7',hubVersion:'0.2.6',status:'different'}}
 await pane({getState:()=>snapshot},async({doc,autoRefresh})=>{
  const connection=doc.querySelector('.bt-comm-connection')
  assert.equal(connection.querySelector('.bt-comm-connection-label').textContent,'Connected to Hub')
  assert.match(connection.textContent,/V0\.2\.7.*V0\.2\.6/)
  assert.equal(connection.dataset.compact,'true')
  assert.equal(connection.querySelectorAll('.bt-comm-connection-line').length,1)
  assert.equal(connection.querySelector(':scope>p[role=status]'),null)
  assert.match(connection.querySelector('.bt-comm-connection-line').title,/protocols and capabilities/)
  snapshot={...snapshot,compatibility:{...snapshot.compatibility,hubVersion:'0.2.7',status:'matched'}}
  await autoRefresh()
  assert.equal(connection.querySelector('.bt-comm-connection-label').textContent,'Connected to Hub')
 })
})


test('Contacts shows only pending request counts, refreshes without opening the dialog and clears after resolution',async()=>{
 const snapshot={...state(),managementRevision:1}
 let requests=[{requestId:'incoming',status:'pending',direction:'incoming'},{requestId:'outgoing',status:'pending',direction:'outgoing'},{requestId:'old',status:'rejected',direction:'incoming'}]
 await pane({snapshot,handle:async body=>body.endpoint==='contact-requests'?requests:[]},async({doc,button,autoRefresh,calls})=>{
  const badge=()=>button('Contacts').querySelector('.bt-comm-request-badge')
  assert.equal(badge().textContent,'2')
  assert.equal(badge().getAttribute('aria-label'),'2 pending')
  assert.equal(button('Contacts').getAttribute('aria-describedby'),badge().id)
  assert.equal(doc.querySelector('.bt-comm-modal'),null)
  requests=requests.map(item=>({...item,status:'accepted'}));snapshot.managementRevision++
  await autoRefresh()
  assert.equal(badge(),null)
  assert.equal(button('Contacts').hasAttribute('aria-describedby'),false)
  requests=[{requestId:'new',status:'pending',direction:'incoming'}];snapshot.managementRevision++
  await autoRefresh();assert.equal(badge().textContent,'1')
  snapshot.connected=false;await autoRefresh();assert.equal(badge(),null)
  assert.ok(calls.some(call=>call.endpoint==='contact-requests'))
  assert.equal(calls.some(call=>['accept-contact','reject-contact','cancel-contact','request-contact'].includes(call.endpoint)),false)
 })
})

test('a late request count from a previous Hub cannot add a badge to the selected Hub',async()=>{
 let finish
 let snapshot={...state(),hubId:'hub-a'}
 await pane({getState:()=>snapshot,handle:async body=>body.endpoint==='contact-requests'?new Promise(resolve=>{finish=resolve}):[]},async({roster,button,autoRefresh})=>{
  assert.equal(typeof finish,'function')
  const oldFinish=finish
  await act(async()=>{snapshot={...state(),hubId:'hub-b',connected:false};updateLiveRoster(roster,{communicationEnabled:true,communicationHubId:'hub-b'})})
  await autoRefresh()
  await act(async()=>oldFinish([{requestId:'old-hub-request',status:'pending'}]))
  assert.equal(button('Contacts').querySelector('.bt-comm-request-badge'),null)
 })
})


test('older client releases show an advisory while connected, and a required update only for protocol failure',async()=>{
 let snapshot={...state(),compatibility:{clientVersion:'0.2.7',hubVersion:'0.2.8',status:'different'}}
 await pane({getState:()=>snapshot},async({doc,autoRefresh})=>{
  const connection=()=>doc.querySelector('.bt-comm-connection')
  assert.match(connection().querySelector('.bt-comm-connection-line').title,/newer client release is available/)
  assert.match(connection().querySelector('.bt-comm-connection-line').getAttribute('aria-description'),/communication remains available/)
  assert.equal(connection().querySelector('.bt-comm-connection-label').textContent,'Connected to Hub')
  snapshot={...snapshot,connected:false,error:'HUB_CONNECTION_REFUSED'}
  await autoRefresh()
  assert.doesNotMatch(connection().textContent,/Client update required to connect/)
  snapshot={...snapshot,error:'UNSUPPORTED_CAPABILITY',compatibility:{...snapshot.compatibility,status:'incompatible',updateTarget:'client'}}
  await autoRefresh()
  assert.equal(connection().querySelector('.bt-comm-connection-label').textContent,'Client update required to connect')
  assert.match(connection().textContent,/required protocol or capabilities are not supported/)
 })
})

test('every personal-settings category folds independently and preserves a profile draft without saving',async()=>{
 await pane({snapshot:{...state(),conversations:[membership]},handle:async body=>body.endpoint==='human-profile-info'?{principalId:'human:a:owner',publicProfile:{version:0}}:{}},async({doc,click,edit,calls})=>{
  await click('Personal settings')
  const sections=[...doc.querySelectorAll('.bt-comm-personal-settings .bt-comm-profile-section')]
  assert.deepEqual(sections.map(node=>node.querySelector(':scope>summary').textContent),['Your profile','Device identity','Remote work confirmation','Your user code','Published Bots','Local memory in remote conversations','Hub connection'])
  assert.ok(sections.every(node=>!node.open))
  const profile=sections[0],input=profile.querySelector('[aria-label="Human name"]')
  await act(async()=>profile.querySelector('summary').click());await edit(input,'Unsaved profile draft')
  await act(async()=>profile.querySelector('summary').click());assert.equal(profile.open,false)
  await act(async()=>profile.querySelector('summary').click());assert.equal(input.value,'Unsaved profile draft')
  assert.ok(!calls.some(call=>['profile-human','profile-human-info','publish-bots'].includes(call.endpoint)))
 })
})

test('clicking a group message avatar inspects the exact member and restores focus without sending',async()=>{
 const bot={principalId:'bot:b:tester',displayName:'Tester',kind:'bot',ownerPrincipalId:'human:b:buddy'},owner={principalId:'human:b:buddy',displayName:'Buddy',kind:'human'}
 const events=[{type:'message',conversationSeq:1,serverAcceptedAt:'2026-11-09T00:00:00Z',message:{messageId:'avatar-source',author:bot,content:{text:'Testing result'},mentions:[]}}]
 await pane({snapshot:{...state(),conversations:[{...membership,info:{members:[...membership.info.members,owner,bot]}}]},history:events,handle:async body=>body.endpoint==='participant-profile'?{principalId:bot.principalId,publicProfile:{version:1,headline:'Testing specialist',summary:'Reproduce and investigate failures',expertise:['Regression testing']}}:{}},async({doc,click,calls})=>{
  await click('Shared group')
  const trigger=doc.querySelector('article[data-message-id="avatar-source"] button.bt-comm-avatar-button')
  await act(async()=>trigger.click())
  const details=doc.querySelector('[aria-label="Participant information"]')
  assert.match(details.textContent,/Buddy/);assert.match(details.textContent,/Regression testing/)
  const request=calls.find(call=>call.endpoint==='participant-profile')
  assert.equal(request.targetPrincipalId,bot.principalId);assert.equal(request.membershipEpoch,'epoch')
  assert.equal(calls.some(call=>call.endpoint==='send'),false)
  await click('Close dialog');assert.ok(doc.activeElement===trigger,'focus returns to the message avatar')
 })
})

test('new messages behind personal settings stay unread until the current conversation is visible again',async()=>{
 let watermark=1
 const events=()=>Array.from({length:watermark},(_,index)=>({type:'message',conversationSeq:index+1,serverAcceptedAt:'2026-11-09T00:00:00Z',message:{messageId:'read-'+index,author:membership.info.members[0],content:{text:'Message '+index},mentions:[]}}))
 await pane({getState:()=>({...state(),conversations:[{...membership,watermark}]}),history:events},async({dom,doc,click,calls,autoRefresh})=>{
  Object.defineProperty(doc,'hasFocus',{value:()=>true,configurable:true})
  await click('Shared group');await act(async()=>dom.window.dispatchEvent(new dom.window.Event('focus')))
  assert.ok(calls.some(call=>call.endpoint==='read'&&call.seq===1))
  await click('Personal settings');watermark=2;await autoRefresh()
  assert.equal(calls.some(call=>call.endpoint==='read'&&call.seq===2),false)
  await click('Close dialog')
  assert.ok(calls.some(call=>call.endpoint==='read'&&call.seq===2&&call.membershipEpoch==='epoch'))
 })
})

test('progressive history follows the contiguous cached watermark without spinning on an ahead-of-cache Hub watermark',async()=>{
 let cached=1
 const event=i=>({type:'message',conversationSeq:i,serverAcceptedAt:'2026-11-09T00:00:00Z',message:{messageId:'cached-'+i,author:membership.info.members[0],content:{text:'Cached message '+i},mentions:[]}})
 await pane({getState:()=>({...state(),conversations:[{...membership,watermark:100,cachedWatermark:cached}]}),history:body=>({conversationId:'group',membershipEpoch:'epoch',watermark:cached,events:Array.from({length:cached},(_,i)=>event(i+1)).filter(row=>row.conversationSeq>(body.after??0)),hasEarlier:false,hasLater:false})},async({doc,click,calls,autoRefresh})=>{
  await click('Shared group');await autoRefresh()
  assert.equal(calls.filter(item=>item.endpoint==='history').length,1)
  cached=2;await autoRefresh()
  assert.ok(doc.querySelector('[data-message-id="cached-2"]'))
  assert.equal(calls.filter(item=>item.endpoint==='history'&&item.after===1).length,1)
 })
})

test('late history-search results cannot overwrite a newer query or render received markup',async()=>{
 let resolveOld
 await pane({snapshot:{...state(),conversations:[membership]},handle:async body=>body.endpoint==='search-history'?(body.query==='old'?new Promise(resolve=>{resolveOld=resolve}):{results:[{conversationId:'group',membershipEpoch:'epoch',messageId:'new-hit',conversationSeq:1,author:membership.info.members[0],excerpt:'new target <img src=x onerror=alert(1)>'}],hasMore:false}):{}},async({doc,click,edit,calls})=>{
  await click('Shared group');await click('Search chat history')
  const input=doc.querySelector('[aria-label="Search chat history"] input')??doc.querySelector('input[aria-label="Search chat history"]')
  await edit(input,'old');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300))})
  assert.ok(resolveOld)
  await edit(input,'new');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300))})
  assert.match(doc.querySelector('.bt-comm-history-results').textContent,/new target/)
  await act(async()=>resolveOld({results:[{conversationId:'group',membershipEpoch:'epoch',messageId:'old-hit',conversationSeq:1,author:membership.info.members[0],excerpt:'STALE OLD RESULT'}],hasMore:false}))
  assert.doesNotMatch(doc.querySelector('.bt-comm-history-results').textContent,/STALE OLD RESULT/)
  assert.equal(doc.querySelector('.bt-comm-history-results img'),null)
  assert.equal(calls.some(item=>['send','publish-bots'].includes(item.endpoint)),false)
 })
})

function inviteFixture(){
 const owner={principalId:'human:b:buddy',displayName:'Buddy',kind:'human',homeInstanceId:'b'}
 const one={principalId:'bot:b:one',displayName:'One',kind:'bot',ownerPrincipalId:owner.principalId,homeInstanceId:'b'},two={...one,principalId:'bot:b:two',displayName:'Two'}
 const snapshot={...state(),contacts:[owner,one,two],conversations:[{...membership,info:{members:[...membership.info.members]}}]}
 const canonical=()=>({members:snapshot.conversations[0].info.members,membershipVersion:snapshot.conversations[0].membershipVersion})
 const join=id=>{const row=snapshot.conversations[0],addition=[owner,[one,two].find(bot=>bot.principalId===id)].filter(person=>!row.info.members.some(existing=>existing.principalId===person.principalId));snapshot.conversations=[{...row,membershipVersion:row.membershipVersion+addition.length,info:{...row.info,members:[...row.info.members,...addition]}}]}
 return {owner,one,two,snapshot,canonical,join}
}

test('existing group invitation selects multiple Bots and refreshes the exact version between automatic owner joins',async()=>{
 const f=inviteFixture(),invited=[]
 await pane({snapshot:f.snapshot,getState:()=>f.snapshot,handle:async body=>{
  if(body.endpoint==='members')return f.canonical()
  if(body.endpoint==='invite'){assert.equal(body.expectedVersion,f.canonical().membershipVersion);invited.push(body);f.join(body.inviteePrincipalId);return {joined:true}}
  return {}
 }},async({doc,click})=>{
  await click('Shared group');await click('View conversation details');await click('Invite participant')
  const dialog=doc.querySelector('dialog[aria-label="Invite participant"]')
  assert.equal(dialog.querySelectorAll('input[type=checkbox]').length,2);assert.equal(dialog.querySelectorAll('input[type=radio]').length,0)
  await act(async()=>dialog.querySelector('[aria-label="Invite One"]').click());await act(async()=>dialog.querySelector('[aria-label="Invite Two"]').click())
  assert.match(dialog.textContent,/Selected Bots: 2/)
  await click('Invite')
  assert.deepEqual(invited.map(body=>body.inviteePrincipalId),[f.one.principalId,f.two.principalId]);assert.deepEqual(invited.map(body=>body.expectedVersion),[1,3])
  assert.equal(f.canonical().members.filter(person=>person.principalId===f.owner.principalId).length,1)
  assert.equal(f.canonical().members.length,4)
 })
})

test('partial multi-invite keeps only failed selections and never invites successful Bots again',async()=>{
 const f=inviteFixture(),invited=[];let reject=true
 await pane({snapshot:f.snapshot,getState:()=>f.snapshot,handle:async body=>{
  if(body.endpoint==='members')return f.canonical()
  if(body.endpoint==='invite'){invited.push(body);if(reject&&body.inviteePrincipalId===f.two.principalId)throw Object.assign(Error('private details'),{code:'BOT_RETIRED'});f.join(body.inviteePrincipalId);return {joined:true}}
  return {}
 }},async({doc,click})=>{
  await click('Shared group');await click('View conversation details');await click('Invite participant')
  const dialog=()=>doc.querySelector('dialog[aria-label="Invite participant"]')
  await act(async()=>dialog().querySelector('[aria-label="Invite One"]').click());await act(async()=>dialog().querySelector('[aria-label="Invite Two"]').click());await click('Invite')
  assert.ok(dialog());assert.match(dialog().textContent,/One · Joined/);assert.match(dialog().textContent,/Two · Could not join/)
  assert.doesNotMatch(dialog().textContent,/private details/);assert.equal(dialog().querySelector('[aria-label="Invite Two"]').checked,true)
  reject=false;await click('Invite')
  assert.deepEqual(invited.map(body=>body.inviteePrincipalId),[f.one.principalId,f.two.principalId,f.two.principalId])
 })
})

test('an uncertain invitation pauses the batch and survives remount with its original operation ID and version',async()=>{
 const f=inviteFixture(),invited=[];let first=true
 await pane({snapshot:f.snapshot,getState:()=>f.snapshot,handle:async body=>{
  if(body.endpoint==='members')return f.canonical()
  if(body.endpoint==='invite'){invited.push(body);if(first){first=false;f.join(body.inviteePrincipalId);throw Object.assign(Error('lost acknowledgement'),{code:'REQUEST_TIMEOUT'})}if(!f.canonical().members.some(person=>person.principalId===body.inviteePrincipalId))f.join(body.inviteePrincipalId);return {joined:true}}
  return {}
 }},async({doc,click,remount})=>{
  await click('Shared group');await click('View conversation details');await click('Invite participant')
  const dialog=()=>doc.querySelector('dialog[aria-label="Invite participant"]')
  await act(async()=>dialog().querySelector('[aria-label="Invite One"]').click());await act(async()=>dialog().querySelector('[aria-label="Invite Two"]').click());await click('Invite')
  assert.equal(invited.length,1);assert.match(dialog().textContent,/not confirmed/)
  await click('Cancel');await remount();await click('View conversation details');await click('Invite participant')
  assert.match(dialog().textContent,/One · Not confirmed/)
  await act(async()=>dialog().querySelector('[aria-label="Invite Two"]').click());await click('Invite')
  assert.equal(invited.length,3);assert.equal(invited[0].operationId,invited[1].operationId);assert.equal(invited[1].expectedVersion,1);assert.equal(invited[2].expectedVersion,3)
 })
})

test('group capacity rejection is definitive, stops the batch, and leaves the selection editable for a fresh retry',async()=>{
 const f=inviteFixture(),invited=[];let full=true
 const {communicationError}=await import('../src/shared/communication-diagnostics.js')
 assert.equal(communicationError({code:'MEMBER_LIMIT'}).code,'MEMBER_LIMIT')
 await pane({snapshot:f.snapshot,getState:()=>f.snapshot,handle:async body=>{
  if(body.endpoint==='members')return f.canonical()
  if(body.endpoint==='invite'){invited.push(body);if(full)throw Object.assign(Error('capacity'),{code:'MEMBER_LIMIT'});f.join(body.inviteePrincipalId);return {joined:true}}
  return {}
 }},async({doc,click})=>{
  await click('Shared group');await click('View conversation details');await click('Invite participant')
  const dialog=()=>doc.querySelector('dialog[aria-label="Invite participant"]')
  await act(async()=>dialog().querySelector('[aria-label="Invite One"]').click());await act(async()=>dialog().querySelector('[aria-label="Invite Two"]').click());await click('Invite')
  assert.equal(invited.length,1);assert.equal(f.canonical().members.length,1)
  assert.equal(dialog().querySelector('[aria-label="Invite One"]').disabled,false)
  assert.match(dialog().textContent,/member limit/)
  full=false;await click('Invite')
  assert.equal(invited.length,3);assert.notEqual(invited[0].operationId,invited[1].operationId)
 })
})

test('default receiving Bots use a separate multi-select dialog; Cancel preserves selection and one Save commits the list',async()=>{
 const snapshot=state();snapshot.multipleDefaultBotsAvailable=true
 const a={principalId:'bot:a:first',displayName:'First',kind:'bot',role:'member',speakingMode:'passive',ownerPrincipalId:'human:a:owner',published:true}
 const owner={principalId:'human:b:owner',displayName:'Buddy',kind:'human',role:'member',speakingMode:'readOnly'}
 const b={...a,principalId:'bot:b:second',displayName:'Second',ownerPrincipalId:owner.principalId}
 snapshot.contacts=[owner,b]
 snapshot.conversations=[{...membership,routingMode:'admin',adminBotPrincipalId:a.principalId,info:{members:[...membership.info.members,a,owner,b]}}]
 await pane({snapshot,handle:async body=>{
  assert.equal(body.endpoint,'save-settings')
  snapshot.conversations=[{...snapshot.conversations[0],defaultBotPrincipalIds:body.routing.defaultBotPrincipalIds,membershipVersion:2}]
  return{updated:true,membershipVersion:2,conversationId:'group'}
 }},async({doc,click,calls})=>{
  await click('Shared group');await act(async()=>doc.querySelector('.bt-comm-members summary').click())
  await click('Choose receiving Bots')
  let dialog=doc.querySelector('dialog[open]');assert.match(dialog.textContent,/Buddy/)
  assert.equal(dialog.querySelector('[data-receiving-bot="bot:a:first"]').checked,true)
  await act(async()=>dialog.querySelector('[data-receiving-bot="bot:b:second"]').click())
  await click('Cancel')
  assert.equal(doc.querySelector('[aria-label="Save group settings"]').disabled,true)
  await click('Choose receiving Bots');dialog=doc.querySelector('dialog[open]:not([data-closing=true])')
  assert.equal(dialog.querySelector('[data-receiving-bot="bot:b:second"]').checked,false)
  await act(async()=>dialog.querySelector('[data-receiving-bot="bot:b:second"]').click())
  await click('Use selected Bots')
  assert.equal(calls.filter(c=>c.endpoint==='save-settings').length,0)
  assert.match(doc.querySelector('[aria-label="Default receiving Bots"]').textContent,/First.*Second/)
  await click('Save')
  const saves=calls.filter(c=>c.endpoint==='save-settings')
  assert.equal(saves.length,1);assert.deepEqual(Array.from(saves[0].routing.defaultBotPrincipalIds),[a.principalId,b.principalId])
  assert.equal(saves[0].expectedVersion,1)
 })
})

test('old Hub allows a single default but explains and blocks multi-selection; disabled default mode cannot save an empty list',async()=>{
 const snapshot=state()
 const bots=['one','two'].map(id=>({principalId:'bot:a:'+id,displayName:id,kind:'bot',role:'member',speakingMode:'passive',ownerPrincipalId:'human:a:owner'}))
 snapshot.conversations=[{...membership,info:{members:[...membership.info.members,...bots]}}]
 await pane({snapshot},async({doc,click,edit,calls,button})=>{
  await click('Shared group');await act(async()=>doc.querySelector('.bt-comm-members summary').click())
  await edit(doc.querySelector('select[aria-label="Receiving rule"]'),'admin')
  assert.equal(doc.querySelector('[aria-label="Save group settings"]').disabled,true)
  await click('Choose receiving Bots')
  const dialog=doc.querySelector('dialog[open]:not([data-closing=true])')
  for(const input of dialog.querySelectorAll('[data-receiving-bot]'))await act(async()=>input.click())
  assert.match(dialog.textContent,/Update the Hub to select more than one Bot/)
  assert.equal(button('Use selected Bots').disabled,true)
  await act(async()=>dialog.querySelector('[data-receiving-bot="bot:a:one"]').click())
  assert.equal(button('Use selected Bots').disabled,false)
  await click('Use selected Bots')
  assert.equal(doc.querySelector('[aria-label="Save group settings"]').disabled,false)
  assert.equal(calls.some(c=>c.endpoint==='save-settings'),false)
 })
})

test('both composers show actual Bot avatars for defaults, typed mentions and directed replies',async()=>{
 const bots=['Alpha','Beta'].map(name=>({principalId:'bot:b:'+name,displayName:name,kind:'bot',published:true,speakingMode:'passive'}))
 const member={...membership,info:{...membership.info,membershipVersion:1,routingMode:'admin',defaultBotPrincipalIds:bots.map(bot=>bot.principalId),members:[...membership.info.members,...bots]}}
 const event={type:'message',conversationSeq:1,serverAcceptedAt:'2026-11-11T00:00:00Z',message:{messageId:'bot-result',author:bots[0],content:{text:'Progress report'},mentions:[],replyToMessageId:null}}
 await pane({snapshot:{...state(),directedGroupRepliesAvailable:true,replyMentionUnionAvailable:true,conversations:[member]},history:[event],handle:async body=>body.endpoint==='thread'?{conversationId:'group',membershipEpoch:'epoch',messageId:'bot-result',rootMessageId:'bot-result',events:[event],watermark:1}:{}},async({doc,click,edit,calls})=>{
  await click('Shared group')
  const ids=selector=>[...doc.querySelectorAll(selector+' [data-recipient-id]')].map(node=>node.dataset.recipientId)
  assert.deepEqual(ids('footer'),bots.map(bot=>bot.principalId))
  await edit(doc.querySelector('footer textarea'),'@Beta help')
  assert.deepEqual(ids('footer'),[bots[1].principalId])
  await click('Reply')
  assert.deepEqual(ids('.bt-comm-thread-composer'),[bots[0].principalId])
  await edit(doc.querySelector('.bt-comm-thread-composer textarea'),'@Beta too')
  assert.deepEqual(ids('.bt-comm-thread-composer'),bots.map(bot=>bot.principalId))
  await edit(doc.querySelector('.bt-comm-thread-composer textarea'),'@Owner human only')
  assert.deepEqual(ids('.bt-comm-thread-composer'),[bots[0].principalId])
  assert.equal(calls.some(call=>call.endpoint==='send'),false)
 })
})

test('first @all in a new empty group displays both the message and Bot reply without reloading',async()=>{
 const bot={principalId:'bot:b:peer',displayName:'Peer',kind:'bot',speakingMode:'passive',published:true}
 const events=[]
 const group={...membership,watermark:0,cachedWatermark:0,info:{...membership.info,membershipVersion:1,members:[...membership.info.members,bot]}}
 const event=(id,author,text)=>({type:'message',conversationId:'group',conversationSeq:events.length+1,serverAcceptedAt:'2026-11-12T00:00:00Z',message:{messageId:id,author,content:{text},mentions:[],replyToMessageId:null}})
 await pane({getState:()=>({...state(),conversations:[{...group,watermark:events.length,cachedWatermark:events.length}]}),
  history:body=>({conversationId:'group',membershipEpoch:'epoch',watermark:events.length,events:events.filter(e=>e.conversationSeq>(body.after??0)),hasEarlier:false,hasLater:false}),
  handle:async body=>{
   if(body.endpoint==='send'){
    events.push(event(body.messageId,membership.info.members[0],body.text))
    events.push(event('first-bot-reply',bot,'I received the first broadcast'))
    return {messageId:body.messageId,status:'pending'}
   }
   return {}
  }},async({doc,click,edit,calls,autoRefresh})=>{
   await click('Shared group')
   assert.equal(doc.querySelectorAll('.bt-comm-log article[data-message-id]').length,0)
   await edit(doc.querySelector('footer textarea'),'@all hello')
   await click('Send message')
   assert.equal(Boolean(doc.querySelector('[data-message-id="first-bot-reply"]')),true,'first Bot reply must appear without F5')
   assert.equal(doc.querySelectorAll('.bt-comm-log article[data-message-id]').length,2)
   const initialReads=calls.filter(c=>c.endpoint==='history')
   assert.equal(initialReads.length,2);assert.equal(initialReads[1].latest,true)
   events.push(event('later-bot-reply',bot,'Later progress'))
   await autoRefresh()
   assert.equal(Boolean(doc.querySelector('[data-message-id="later-bot-reply"]')),true)
   assert.equal(calls.filter(c=>c.endpoint==='history'&&c.after===2).length,1)
   assert.equal(calls.filter(c=>c.endpoint==='send').length,1)
  })
})

test('mid-sentence mentions show avatars and owners in both composers and retain exact sending targets',async()=>{
 const owner={principalId:'human:b:owner',displayName:'Lisa',kind:'human'}
 const bot={principalId:'bot:b:helper',displayName:'助手',kind:'bot',ownerPrincipalId:owner.principalId,published:true,speakingMode:'passive'}
 const member={...membership,info:{membershipVersion:1,members:[...membership.info.members,owner,bot]}}
 const event={type:'message',conversationSeq:1,message:{messageId:'reply-root',author:bot,content:{text:'Report'},mentions:[],replyToMessageId:null}}
 await pane({snapshot:{...state(),conversations:[member]},history:[event],handle:async body=>body.endpoint==='thread'?{conversationId:'group',membershipEpoch:'epoch',rootMessageId:'reply-root',messageId:'reply-root',events:[event],watermark:1}:{}},async({doc,click,edit,calls,dom})=>{
  await click('Shared group')
  const choose = async field=>{
   await edit(field,'请帮忙@助')
   const option=doc.querySelector('[role=option]')
   assert.match(option.textContent,/助手 - Lisa/)
   assert.equal(option.querySelector('[data-avatar-id]').dataset.avatarId,bot.principalId)
   await act(async()=>option.click())
   assert.equal(field.value,'请帮忙@助手 ')
   await edit(field,field.value+'检查进展')
  }
  await choose(doc.querySelector('footer textarea'))
  await act(async()=>doc.querySelector('footer textarea').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  assert.deepEqual([...calls.find(call=>call.endpoint==='send').mentions],[bot.principalId])
  await click('Reply')
  await choose(doc.querySelector('.bt-comm-thread-composer textarea'))
  await act(async()=>doc.querySelector('.bt-comm-thread-composer textarea').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
  const sends=calls.filter(call=>call.endpoint==='send')
  assert.equal(sends.length,2)
  assert.deepEqual([...sends[1].mentions],[bot.principalId])
  assert.equal(sends[1].replyToMessageId,'reply-root')
 })
})

test('large recipient sets are compact with complete vertical lists in messages and both composers',async()=>{
 const bots=Array.from({length:12},(_,i)=>({principalId:'bot:b:'+i,displayName:'Bot '+i,kind:'bot',published:true,speakingMode:'passive'}))
 const member={...membership,info:{membershipVersion:1,members:[...membership.info.members,...bots]}}
 const event={type:'message',conversationSeq:1,activatedBotPrincipalIds:bots.map(b=>b.principalId),message:{messageId:'broadcast',author:membership.info.members[0],content:{text:'@all status'},mentions:[],replyToMessageId:null}}
 await pane({snapshot:{...state(),conversations:[member]},history:[event],handle:async body=>body.endpoint==='thread'?{conversationId:'group',membershipEpoch:'epoch',rootMessageId:'broadcast',messageId:'broadcast',events:[event],watermark:1}:{}},async({doc,click,edit,calls,dom})=>{
  await click('Shared group')
  const expand=async selector=>{
   const area=doc.querySelector(selector)
   assert.equal(area.querySelectorAll('.bt-comm-bot-chip').length,2)
   const trigger=area.querySelector('.bt-comm-bot-more')
   assert.match(trigger.textContent,/12/)
   await act(async()=>trigger.click())
   assert.equal(doc.querySelectorAll('.bt-comm-bot-popover li').length,12)
   assert.equal(doc.querySelectorAll('.bt-comm-bot-popover li [data-avatar-id]').length,12)
   await act(async()=>doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
   assert.equal(Boolean(doc.querySelector('.bt-comm-bot-popover')),false)
  }
  await expand('.bt-comm-log .bt-comm-activation')
  await edit(doc.querySelector('footer textarea'),'@all status')
  await expand('footer .bt-comm-recipient-preview')
  await click('Reply')
  await edit(doc.querySelector('.bt-comm-thread-composer textarea'),'@all next')
  await expand('.bt-comm-thread-composer .bt-comm-recipient-preview')
  assert.equal(Boolean(doc.querySelector('.bt-comm-thread')),true)
  assert.equal(calls.some(call=>call.endpoint==='send'),false)
 })
})

test('message activation uses Hub evidence rather than display mentions or pending intentions',async()=>{
 const bot={principalId:'bot:b:one',displayName:'Bot One',kind:'bot'}
 const member={...membership,info:{membershipVersion:1,members:[...membership.info.members,bot]}}
 const history=[undefined,[],[bot.principalId]].map((ids,i)=>({type:'message',conversationSeq:i+1,...(ids?{activatedBotPrincipalIds:ids}:{}),message:{messageId:'e'+i,author:membership.info.members[0],content:{text:'@all'},mentions:[{principalId:bot.principalId}],replyToMessageId:null}}))
 await pane({snapshot:{...state(),conversations:[member]},history},async({doc,click})=>{
  await click('Shared group')
  assert.match(doc.querySelector('[data-message-id=e0] .bt-comm-activation').textContent,/Dispatch not recorded/)
  assert.equal(Boolean(doc.querySelector('[data-message-id=e1] .bt-comm-activation')),false)
  assert.equal(doc.querySelectorAll('[data-message-id=e2] [data-activated-bot]').length,1)
 })
})

test('an existing orphan application exposes only withdrawal and reconciles a lost local-cleanup response',async()=>{
 const item={hubId:'old-hub',url:'wss://hub.example.test/communication',requestId:'old-orphan',status:'pending',identityFingerprint:'f'.repeat(64)}
 let saved=true
 await pane({enabled:false,handle:async body=>{
  if(body.endpoint==='onboarding-storage')return {storage:{defaultProvider:'test'},enrollments:saved?[item]:[]}
  if(body.endpoint==='hub-join-status')throw Object.assign(Error('missing'),{code:'JOIN_NOT_FOUND'})
  if(body.endpoint==='forget-hub'){
   assert.equal(body.force,true);assert.equal(body.expectedIdentity,item.identityFingerprint)
   assert.equal(body.confirmForget,true);assert.equal(body.deleteLocalHistory,false)
   saved=false;throw Object.assign(Error('lost local response'),{code:'CONNECTION_LOST'})
  }
  return {}
 }},async({doc,click,button,calls,autoRefresh})=>{
  await click('Personal settings');await click('Join Hub');await autoRefresh()
  assert.equal(button('Forget this Hub'),undefined);assert.equal(button('Force-forget this Hub'),undefined)
  assert.equal(Boolean(doc.querySelector('[aria-label="Hub code"]')),false)
  assert.equal(button('Withdraw request').disabled,false)
  await click('Withdraw request');await click('Confirm withdrawal')
  assert.equal(Boolean(doc.querySelector('dialog[aria-label="Withdraw request"]')),false)
  assert.ok(doc.querySelector('[aria-label="Hub code"]'))
  assert.equal(button('Withdraw request'),undefined)
  assert.equal(calls.filter(c=>c.endpoint==='forget-hub').length,1)
  assert.equal(calls.some(c=>c.endpoint==='cancel-hub-join'||c.endpoint==='leave-hub'),false)
 })
})

test('view reply chain does not select a quote; Reply selects it and all Bot avatars share live presence',async()=>{
 const bot={principalId:'bot:b:peer',displayName:'Peer',kind:'bot',speakingMode:'passive',published:true,connected:true,working:true}
 const group={...membership,info:{...membership.info,membershipVersion:1,members:[...membership.info.members,bot]}}
 let snapshot={...state(),directedGroupRepliesAvailable:true,replyMentionUnionAvailable:true,conversations:[group]}
 const event={type:'message',conversationSeq:1,serverAcceptedAt:'2026-11-12T00:00:00Z',activatedBotPrincipalIds:[bot.principalId],message:{messageId:'result',author:bot,content:{text:'Progress report'},mentions:[],replyToMessageId:null}}
 await pane({getState:()=>snapshot,history:[event],handle:async body=>body.endpoint==='thread'?{conversationId:'group',membershipEpoch:'epoch',messageId:'result',rootMessageId:'result',events:[event],watermark:1}:{}},async({doc,click,edit,autoRefresh})=>{
  await click('Shared group')
  assert.ok(doc.querySelector('[data-avatar-id="bot:b:peer"] [data-bot-status="working"]'))
  assert.equal(doc.querySelector('.bt-comm-activation').textContent.includes('Bot dispatch'),false)
  await click('View replies')
  assert.equal(Boolean(doc.querySelector('.bt-comm-thread-composer')),false)
  await click('Close replies')
  await click('Reply')
  assert.match(doc.querySelector('.bt-comm-thread-composer .bt-comm-reference').textContent,/Progress report/)
  assert.ok(doc.querySelector('.bt-comm-thread-composer [data-bot-status="working"]'))
  await click('Close replies')
  await edit(doc.querySelector('footer textarea'),'@')
  assert.ok(doc.querySelector('[role=listbox] [data-bot-status="working"]'))
  snapshot={...snapshot,connected:false};await autoRefresh()
  assert.equal(doc.querySelectorAll('[data-bot-status="working"],[data-bot-status="online"]').length,0)
  assert.ok(doc.querySelector('[data-bot-status="unknown"]'))
  snapshot={...snapshot,connected:true,conversations:[{...group,info:{...group.info,members:[group.info.members[0],{...bot,working:false}]}}]};await autoRefresh()
  assert.ok(doc.querySelector('[data-bot-status="online"]'))
 })
})

test('DM list, title and message avatars follow current contact revisions even while membership metadata is cached',async()=>{
 for(const kind of ['human','bot']) {
  const peer={principalId:`${kind}:b:peer`,displayName:'Peer',kind,avatar:{imageRevision:'a'.repeat(64)}}
  const owner=membership.info.members[0]
  const dm={...membership,conversationId:'dm',kind:'dm',info:{members:[owner,peer]}}
  let snapshot={...state(),contacts:[owner,peer],conversations:[dm]}
  const first='data:image/png;base64,YQ==',second='data:image/png;base64,Yg=='
  const event={type:'message',conversationSeq:1,serverAcceptedAt:'2026-11-12T00:00:00Z',activatedBotPrincipalIds:[],message:{messageId:'hello',author:peer,content:{text:'Hello'},mentions:[],replyToMessageId:null}}
  await pane({getState:()=>snapshot,history:[event],handle:async body=>body.endpoint==='avatar'?{principalId:peer.principalId,revision:body.revision,image:body.revision.startsWith('a')?first:second}:{}},async({doc,click,autoRefresh})=>{
   await click('Peer')
   const selectors=['[data-conversation-id="dm"]','.bt-comm-title-pill','.bt-comm-log']
   for(const selector of selectors)assert.equal(doc.querySelector(selector+' [data-avatar-id="'+peer.principalId+'"] img')?.getAttribute('src'),first)
   snapshot={...snapshot,contacts:[owner,{...peer,avatar:{imageRevision:'b'.repeat(64)}}]}
   await autoRefresh()
   for(const selector of selectors)assert.equal(doc.querySelector(selector+' [data-avatar-id="'+peer.principalId+'"] img')?.getAttribute('src'),second,selector+' follows the current directory without remount')
   snapshot={...snapshot,contacts:[owner,{...peer,avatar:null}]};await autoRefresh()
   for(const selector of selectors)assert.equal(Boolean(doc.querySelector(selector+' [data-avatar-id="'+peer.principalId+'"] img')),false,selector+' clears a removed avatar')
  })
 }
})


test('Contacts and group views follow profile names, avatar changes and removals without closing the modal',async()=>{
 const peer={principalId:'human:b:peer',kind:'human',displayName:'Peer',avatar:{imageRevision:'a'.repeat(64)}}
 const owner=membership.info.members[0]
 const group={...membership,info:{...membership.info,members:[owner,peer]}}
 let snapshot={...state(),contacts:[owner,peer],conversations:[group]}
 const images={a:'data:image/png;base64,YQ==',b:'data:image/png;base64,Yg=='}
 const event={type:'message',conversationSeq:1,serverAcceptedAt:'2026-11-12T00:00:00Z',activatedBotPrincipalIds:[],message:{messageId:'hello',author:peer,content:{text:'Hello'},mentions:[],replyToMessageId:null}}
 await pane({getState:()=>snapshot,history:[event],handle:async body=>body.endpoint==='avatar'?{principalId:peer.principalId,revision:body.revision,image:images[body.revision[0]]}:[]},async({doc,click,autoRefresh})=>{
  await click('Shared group');await click('Contacts')
  const avatar=()=>doc.querySelector('[data-contact-id="human:b:peer"] img')
  assert.equal(avatar()?.getAttribute('src'),images.a)
  snapshot={...snapshot,contacts:[owner,{...peer,displayName:'Current name',instanceLabel:'Current name',avatar:{imageRevision:'b'.repeat(64)}}]};await autoRefresh()
  assert.equal(avatar()?.getAttribute('src'),images.b)
  assert.match(doc.querySelector('[data-contact-id="human:b:peer"]').textContent,/Current name/)
  assert.doesNotMatch(doc.querySelector('[data-contact-id="human:b:peer"]').textContent,/Peer/)
  for(const image of doc.querySelectorAll('[data-avatar-id="human:b:peer"] img'))assert.equal(image.getAttribute('src'),images.b)
  snapshot={...snapshot,contacts:[owner,{...peer,avatar:null}]};await autoRefresh()
  assert.equal(doc.querySelectorAll('[data-avatar-id="human:b:peer"] img').length,0)
  assert.equal(doc.querySelector('.bt-comm-modal').getAttribute('aria-label'),'Manage contacts')
 })
})
