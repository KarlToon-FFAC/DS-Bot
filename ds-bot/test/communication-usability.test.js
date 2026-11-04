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

async function pane({ enabled = true, snapshot, handle = async () => ({}) }, check) {
  const dom = new JSDOM('<!doctype html><body><textarea id="native">private draft</textarea><div id="root"></div></body>', { url: 'http://127.0.0.1:3138/', pretendToBeVisual: true })
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const { createRoot } = harness('react-dom/client')
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports,
    require: id => id === 'react' ? React : id === 'react-dom' ? harness('react-dom') : { MarkdownText: ({ text }) => React.createElement('p', null, text) },
    window: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage,
    setTimeout, clearTimeout, crypto: globalThis.crypto, AbortSignal, requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame })
  const panel = createSource(true), roster = createSource({ communicationEnabled: enabled }), surface = createSource({ mode: 'bot' }), calls = []
  const request = async body => {
    calls.push(body)
    if (body.endpoint === 'state') return snapshot
    if (body.endpoint === 'history') return { conversationId: body.conversationId, membershipEpoch: 'epoch', events: [] }
    if (body.endpoint === 'read') return {}
    return handle(body)
  }
  let root = createRoot(dom.window.document.getElementById('root'))
  const doc = dom.window.document
  const button = label => [...doc.querySelectorAll('button')].find(node => node.textContent === label)
  const click = async label => { assert.ok(button(label), `button: ${label}`); await act(async () => button(label).click()) }
  const edit = async (node, value) => {
    await act(async () => {
      const type = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement
      Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(node, value)
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
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
    assert.equal(doc.querySelector('input[aria-label="Group name"]').value, 'Shared group')
    assert.match(doc.querySelector('.bt-comm-main').textContent, /Group created\. Some invitations were not sent/)
    assert.match(doc.querySelector('.bt-comm-heading').textContent, /Group owner.*Can speak/)
    assert.equal(doc.querySelector('.bt-comm-frame').dataset.browse, 'false')
  })
})

test('connection recovery refreshes status without resending failures and navigation preserves the draft', async () => {
  const snapshot = state(); snapshot.conversations = [membership]; snapshot.connected = false; snapshot.error = 'UNAUTHENTICATED'
  snapshot.outbox = [{ type: 'message.publish', id: 'failed', conversationId: 'group', state: 'failed', text: 'Original denied message', error: 'SPEAKING_FORBIDDEN' }]
  await pane({ snapshot }, async ({ doc, dom, panel, click, edit, calls }) => {
    await click('Shared group')
    assert.match(doc.querySelector('.bt-comm-connection').textContent, /Connection needs attention/)
    assert.doesNotMatch(doc.querySelector('.bt-comm-connection').textContent, /Reconnecting to Hub/)
    assert.match(doc.querySelector('.bt-comm-connection').textContent, /Ask the Hub owner to check its pairing/)
    assert.equal(doc.querySelector('article[data-failed=true]'), null)
    assert.match(doc.querySelector('.bt-comm-feedback').textContent, /read-only access/)
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
    assert.match(doc.querySelector('.bt-comm-status-help').textContent, /not that a reply is complete/)
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
    await edit(doc.querySelector('input[aria-label="Human name"]'), 'Renamed Human')
    await click('Save Human name')
    assert.equal(calls.find(call => call.endpoint === 'rename-human').displayName, 'Renamed Human')
    await edit(doc.querySelector('input[aria-label="Group name"]'), 'Renamed group')
    await click('Save group name')
    const configure = calls.find(call => call.endpoint === 'configure-group')
    assert.equal(configure.title, 'Renamed group')
    assert.equal(configure.conversationId, 'group')
    assert.equal(configure.membershipEpoch, 'epoch')
    assert.equal(configure.expectedVersion, 1)
    assert.ok(configure.operationId)
    await edit(doc.querySelector('.bt-comm-main textarea'), 'Existing draft')
    assert.equal(button('Copy to draft').disabled, true)
    await edit(doc.querySelector('.bt-comm-main textarea'), '')
    await click('Copy to draft')
    assert.equal(doc.querySelector('.bt-comm-main textarea').value, 'Denied original')
    assert.equal(calls.filter(call => call.endpoint === 'send').length, 0)
  })
})


test('pairing guide is available before and after configuration and never performs API mutations', async () => {
  for (const enabled of [false, true]) {
    await pane({ enabled, snapshot: state(), handle: async () => { throw new Error('Guide must not call an action') } }, async ({ doc, dom, calls, click, panel }) => {
      const before = calls.length
      await click('Add a device')
      const guide = doc.querySelector('.bt-comm-modal[aria-label="Pairing guide"]')
      assert.ok(guide)
      assert.match(guide.textContent, /Hub owner must authorize each device.*restart the Hub/)
      assert.match(guide.textContent, /does not pair a device or change permissions/)
      assert.match(guide.textContent, /environment variable names may differ/)
      assert.match(guide.textContent, /local secret mechanism/)
      assert.match(guide.textContent, /publishedBotIds/)
      assert.match(guide.textContent, /Each instance has its own Human/)
      assert.match(guide.textContent, /Readiness alone does not prove pairing/)
      const peer = JSON.parse(guide.querySelector('pre[aria-label="Hub configuration example"]').textContent).peers[0]
      assert.equal(peer.instanceId, 'new-device')
      assert.equal(peer.credentialEnv, 'DSBOT_HUB_NEW_DEVICE_CREDENTIAL')
      assert.equal(Object.hasOwn(peer, 'credential'), false)
      assert.match(guide.querySelector('pre[aria-label="Device configuration example"]').textContent, /url: wss:\/\/hub.example.test:3190\/communication/)
      assert.equal(guide.querySelectorAll('input,textarea').length, 0)
      assert.equal(calls.length, before)
      await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      assert.equal(doc.querySelector('.bt-comm-modal'), null)
      assert.equal(panel.getSnapshot(), true)
      assert.equal(calls.length, before)
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
    assert.match(doc.querySelector('aside').textContent, /operation is not confirmed/)
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
