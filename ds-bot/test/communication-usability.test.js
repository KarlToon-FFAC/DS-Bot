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

async function pane({ enabled = true, snapshot, history = [], getState, handleRead = async () => ({}), MarkdownText = ({ text }) => React.createElement('p', null, text), handle = async () => ({}) }, check) {
  const dom = new JSDOM('<!doctype html><body><textarea id="native">private draft</textarea><div id="root"></div></body>', { url: 'http://127.0.0.1:3138/', pretendToBeVisual: true })
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const { createRoot } = harness('react-dom/client')
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports,
    require: id => id === 'react' ? React : id === 'react-dom' ? harness('react-dom') : { MarkdownText },
    window: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage,
    setTimeout, clearTimeout, crypto: globalThis.crypto, URL, AbortSignal, requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame })
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
  const click = async label => { assert.ok(button(label), `button: ${label}`); await act(async () => button(label).click()) }
  const edit = async (node, value) => {
    await act(async () => {
      const type = node.tagName === 'SELECT' ? dom.window.HTMLSelectElement : node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement
      Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(node, value)
      node.dispatchEvent(new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
  }
  try {
    await act(async () => root.render(React.createElement(mod.exports.CommunicationSurface, { roster, surface, panel, request })))
    await check({ dom, doc, panel, calls, button, click, edit, remount: async () => {
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

test('uncertain enrollment restores its saved request, exposes safe diagnostics and never automatically resubmits', async () => {
  const hub = { hubId: 'onboarding-test', url: 'wss://hub.example.test/communication' }, storage = { defaultProvider: 'test', encryptedByDefault: false }
  let saved = null, absent = false
  await pane({ enabled: false, handle: async body => {
    if (body.endpoint === 'onboarding-storage') return saved ? { configured: true, storage, ...saved } : { configured: false, storage, enrollments: [] }
    if (body.endpoint === 'decode-hub-code') return hub
    if (body.endpoint === 'join-hub') { saved = { ...hub, requestId: 'same-request', status: 'prepared' }; throw Object.assign(new Error('DO_NOT_DISPLAY_RAW_FAILURE'), { code: 'CONNECTION_LOST', phase: 'ENROLLMENT_PROOF_FAILED' }) }
    if (body.endpoint === 'hub-join-status') { if (absent) throw Object.assign(new Error('not found'), { code: 'JOIN_NOT_FOUND' }); saved.status = 'pending'; return saved }
    assert.fail('Unexpected endpoint')
  } }, async ({ doc, click, edit, calls, button }) => {
    await click('Personal settings'); await click('Add a device')
    await edit(doc.querySelector('[aria-label="Hub code"]'), 'synthetic-public-hub-code'); await click('Review Hub')
    assert.match(doc.querySelector('.bt-comm-onboarding').textContent, /does not test network access or submit/)
    await click('Confirm and request access')
    assert.match(doc.querySelector('.bt-comm-onboarding').textContent, /same-request/)
    assert.match(doc.querySelector('.bt-comm-error').textContent, /CONNECTION_LOST.*ENROLLMENT_PROOF_FAILED/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-error').textContent, /DO_NOT_DISPLAY_RAW_FAILURE/)
    assert.equal(button('Confirm and request access').disabled, true)
    assert.equal(calls.filter(call => call.endpoint === 'hub-join-status').length, 0)
    await click('Refresh saved request'); await click('Check approval')
    assert.equal(calls.filter(call => call.endpoint === 'join-hub').length, 1)
    assert.match(doc.querySelector('.bt-comm-onboarding').textContent, /pending/)
    absent = true; await click('Check approval')
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
  } }, async ({ doc, click, edit, button, calls }) => {
    await click('Personal settings'); await click('Add a device')
    await edit(doc.querySelector('[aria-label="Hub code"]'), 'synthetic-public-hub-code'); await click('Review Hub'); await click('Confirm and request access')
    assert.match(doc.querySelector('.bt-comm-error').textContent, /COMMUNICATION_CREDENTIAL_WRITE_FAILED/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-error').textContent, /DO_NOT_DISPLAY/)
    assert.equal(button('Confirm and request access').disabled, true)
    await click('Refresh saved request')
    assert.equal(button('Confirm and request access').disabled, false)
    assert.equal(calls.filter(call => call.endpoint === 'join-hub').length, 1)
  })
})

test('personal gear owns profile, closed visibility, identity and connection settings; closing discards an unsaved profile', async () => {
  const snapshot = { ...state(), conversations: [membership] }
  await pane({ snapshot }, async ({ doc, click, edit, calls }) => {
    assert.equal(doc.querySelectorAll('.bt-comm-nav-heading button[aria-label="Personal settings"]').length, 1)
    assert.doesNotMatch(doc.querySelector('.bt-comm-nav').textContent, /Human profile|Show closed conversations|Add a device|Manage contacts/)
    await click('Personal settings')
    const modal = doc.querySelector('.bt-comm-personal-settings')
    assert.match(modal.textContent, /Show closed conversations.*Your profile.*Device identity.*Connection and contacts/s)
    await edit(modal.querySelector('input[aria-label="Human name"]'), 'Uncommitted profile')
    await click('Cancel'); await click('Personal settings')
    assert.notEqual(doc.querySelector('input[aria-label="Human name"]').value, 'Uncommitted profile')
    assert.equal(calls.some(call => call.endpoint === 'profile-human'), false)
    await click('Cancel'); await click('Shared group'); await click('Close on this device')
    assert.equal(doc.querySelector('nav button[data-conversation-id="group"]'), null)
    await click('Personal settings')
    await act(async () => doc.querySelector('.bt-comm-personal-settings input[type=checkbox]').click())
    await click('Cancel')
    assert.ok(doc.querySelector('nav button[data-conversation-id="group"]'))
  })
})

test('reply chains render nested branches separately, preserve exact reply intents and offer no read-only send controls', async () => {
  const snapshot = { ...state(), conversations: [{ ...membership }] }
  const events = ['Root', 'Child', 'Deep reply', 'Another branch'].map((text, i) => ({ type: 'message', conversationSeq: i + 1, serverAcceptedAt: '2026-11-04T00:00:00Z', message: { messageId: `m${i}`, author: membership.info.members[0], content: { text }, mentions: [], replyToMessageId: i ? i === 2 ? 'm1' : 'm0' : null } }))
  await pane({ snapshot, history: events, handle: async body => body.endpoint === 'thread' ? { conversationId: 'group', membershipEpoch: 'epoch', messageId: body.messageId, rootMessageId: 'm0', watermark: 4, events, hasMore: false } : {} }, async ({ doc, click, edit, calls }) => {
    await click('Shared group')
    await click('View replies')
    assert.equal(doc.querySelectorAll('.bt-comm-thread-log article').length, 4)
    assert.equal(doc.querySelector('[data-thread-message-id="m2"]').style.getPropertyValue('--reply-depth'), '2')
    assert.match(doc.querySelector('[data-thread-message-id="m2"] .bt-comm-thread-parent').textContent, /Child/)
    assert.equal(doc.querySelectorAll('.bt-comm-thread-branches').length,2)
    const collapse=doc.querySelector('[data-thread-message-id="m1"] button[aria-expanded]')
    await act(async()=>collapse.click())
    assert.equal(doc.querySelector('[data-thread-message-id="m2"]'),null)
    assert.ok(doc.querySelector('[data-thread-message-id="m3"]'),'sibling branch stays visible')
    await act(async()=>collapse.click())
    assert.ok(doc.querySelector('[data-thread-message-id="m2"]'))
    await act(async () => doc.querySelector('[data-thread-message-id="m2"] button').click())
    await edit(doc.querySelector('footer textarea'), 'Continue this exact reply')
    await click('Send message')
    assert.equal(calls.find(call => call.endpoint === 'send').replyToMessageId, 'm2')
    snapshot.conversations[0].speakingMode = 'readOnly'; await click('Refresh status')
    assert.equal(doc.querySelector('footer'), null)
    assert.equal(doc.querySelector('.bt-comm-log button')?.textContent, 'View replies')
    await click('View replies')
    assert.equal([...doc.querySelectorAll('.bt-comm-thread button')].filter(button=>button.textContent==='Reply').length, 0)
    assert.equal(doc.querySelectorAll('.bt-comm-thread-log article').length, 4)
    assert.equal(calls.filter(call => call.endpoint === 'send').length, 1)
  })
})

test('late thread responses cannot survive a selected conversation change or membership revocation', async () => {
  const snapshot = { ...state(), conversations: [{ ...membership }, { ...membership, conversationId: 'other', title: 'Other group', membershipEpoch: 'other' }] }
  const event = { type: 'message', conversationSeq: 1, serverAcceptedAt: '2026-11-04T00:00:00Z', message: { messageId: 'late', author: membership.info.members[0], content: { text: 'Thread canary' }, mentions: [] } }
  let release
  await pane({ snapshot, history: [event], handle: body => body.endpoint === 'thread' ? new Promise(resolve => { release = resolve }) : {} }, async ({ doc, click }) => {
    await click('Shared group'); await click('View replies')
    await click('Cancel'); await click('Other group')
    await act(async () => release({ conversationId: 'group', membershipEpoch: 'epoch', messageId: 'late', rootMessageId: 'late', events: [event] }))
    assert.equal(doc.querySelector('.bt-comm-thread'), null)
    snapshot.conversations = []; await click('Refresh status')
    assert.equal(doc.querySelector('footer'), null)
    assert.equal(doc.querySelector('.bt-comm-thread'), null)
  })
})

test('unconfigured communication explains pairing without API calls, and keyboard users can return to local chats', async () => {
  await pane({ enabled: false }, async ({ doc, dom, panel, calls, button }) => {
    assert.ok(doc.querySelector('[role=dialog][aria-modal=true]'))
    assert.match(doc.querySelector('.bt-comm-main').textContent, /Ask the Hub owner to configure communication/)
    assert.equal(button('New group').disabled, true)
    assert.equal(calls.length, 0)
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
    assert.match(doc.querySelector('.bt-comm-heading').textContent, /Group owner.*Can speak/)
    assert.equal(doc.querySelector('.bt-comm-frame').dataset.browse, 'false')
  })
})

test('connection recovery refreshes status without resending failures and navigation preserves the draft', async () => {
  const snapshot = state(); snapshot.conversations = [membership]; snapshot.connected = false; snapshot.error = 'UNAUTHENTICATED'
  snapshot.outbox = [{ type: 'message.publish', id: 'failed', conversationId: 'group', state: 'failed', text: 'Original denied message', error: 'SPEAKING_FORBIDDEN' }]
  await pane({ snapshot }, async ({ doc, dom, panel, click, edit, calls }) => {
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
    assert.equal(doc.activeElement, memberSettings.querySelector('summary'))
    await click('Refresh status')
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
    await pane({ enabled, snapshot: state(), handle: async body => { assert.equal(body.endpoint, 'onboarding-storage'); return { storage: { defaultProvider: 'owner-acl-plaintext', encryptedByDefault: false, agentIsolation: false }, enrollments: [] } } }, async ({ doc, dom, calls, click, panel }) => {
      await click('Personal settings')
      await click('Add a device')
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
      assert.equal(calls.filter(call => !['state', 'onboarding-storage'].includes(call.endpoint)).length, 0)
      await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      assert.equal(doc.querySelector('.bt-comm-modal'), null)
      assert.equal(panel.getSnapshot(), true)
      assert.equal(calls.filter(call => !['state', 'onboarding-storage'].includes(call.endpoint)).length, 0)
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
    if (attempts.length === 1) throw new TypeError('response lost')
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
  await pane({ snapshot, handle: async body => { assert.equal(body.expectedVersion, 1); throw Object.assign(new Error('stale'), { code: 'GROUP_VERSION_CONFLICT' }) } }, async ({ doc, click, edit }) => {
    await click('Shared group')
    await act(async () => doc.querySelector('.bt-comm-members summary').click())
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Local draft')
    snapshot.conversations = [{ ...membership, title: 'Elsewhere', membershipVersion: 2 }]
    await click('Refresh status')
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
  await pane({ snapshot, handle: async body => new Promise(resolve => { release = () => { snapshot.conversations[0] = { ...membership, title: body.title, membershipVersion: 2 }; resolve({ updated: true, conversationId: 'group', membershipVersion: 2 }) } }) }, async ({ doc, click, edit }) => {
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
    await click('Refresh status')
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
  await pane({ snapshot, history: [source, reply], handle: async body => { assert.equal(body.endpoint, 'reference'); assert.equal(body.conversationId, 'group'); return source } }, async ({ doc, dom, click }) => {
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
    await click('Refresh status')
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
    assert.equal(inspector.querySelectorAll('button').length, 1)
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

test('Hub management uses only the advertised enabled URL and explains unavailable or unsafe entries', async () => {
  const snapshot = { ...state(), hubUrl: 'wss://hub.example.test:3190/communication', managementAvailable: true, managementUrl: 'https://manage.example.test:9443/admin/' }
  await pane({ snapshot }, async ({ doc, calls, click }) => {
    assert.equal(doc.querySelector('.bt-comm-nav a.bt-comm-admin-link'), null)
    assert.doesNotMatch(doc.querySelector('.bt-comm-nav').textContent, /Open Hub management|Hub management/)
    await click('Personal settings')
    const link = doc.querySelector('.bt-comm-personal-settings a.bt-comm-admin-link')
    assert.equal(link.href, snapshot.managementUrl)
    assert.match(link.textContent, /https:\/\/manage.example.test:9443/)
    assert.equal(link.target, '_blank'); assert.match(link.rel, /noopener/); assert.match(link.rel, /noreferrer/)
    assert.equal(calls.some(body => /management|admin/.test(body.endpoint)), false)
  })
  for (const options of [{ managementAvailable: false, managementUrl: null }, { managementAvailable: true, managementUrl: 'https://user:password@hub.example.test/admin/' }, { managementAvailable: true, managementUrl: 'http://remote.example.test/admin/' }]) {
    await pane({ snapshot: { ...snapshot, ...options } }, async ({ doc, click }) => {
      assert.equal(doc.querySelector('a.bt-comm-admin-link'), null)
      await click('Personal settings')
      await click('Hub management')
      assert.match(doc.querySelector('.bt-comm-modal').textContent, /has not provided an active management entry/)
      await click('Open setup guide')
      assert.ok(doc.querySelector('[role=dialog][aria-label="Pairing guide"]'))
      assert.equal(doc.querySelector('a.bt-comm-admin-link'), null, 'no WSS-derived guessed management link in the guide')
    })
  }
})

test('background authorization failures stay quiet and revoked membership clears the visible authorized history', async () => {
  const snapshot = { ...state(), conversations: [{ ...membership, speakingMode: 'readOnly' }] }
  let deny = false
  const event = { type: 'message', conversationSeq: 1, serverAcceptedAt: '2026-11-04T00:00:00.000Z', message: { messageId: 'private-history', author: membership.info.members[0], content: { text: 'Previously authorized history' }, mentions: [] } }
  await pane({ snapshot, history: async () => { if (deny) throw Object.assign(new Error('persistent background denial'), { code: 'FORBIDDEN' }); return [event] } }, async ({ doc, click, calls }) => {
    await click('Shared group')
    assert.match(doc.querySelector('.bt-comm-log').textContent, /Previously authorized history/)
    assert.equal(doc.querySelector('.bt-comm-toast'), null, 'ordinary read-only membership has no error toast')
    deny = true
    for (let index = 0; index < 3; index++) {
      snapshot.conversations[0].watermark += 1
      await click('Refresh status')
      assert.equal(doc.querySelector('.bt-comm-toast'), null, 'persistent history rejection never replays a user notification')
      assert.doesNotMatch(doc.querySelector('.bt-comm-log').textContent, /Previously authorized history/)
    }
    await click('Activity details')
    assert.match(doc.querySelector('.bt-comm-activity').textContent, /permission for this group operation/)
    await click('Cancel')
    snapshot.conversations = []
    await click('Refresh status')
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
