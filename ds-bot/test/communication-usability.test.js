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
  const root = createRoot(dom.window.document.getElementById('root')), doc = dom.window.document
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
    await check({ dom, doc, panel, calls, button, click, edit })
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
    assert.equal(doc.querySelector('input[aria-label="Group name"]').value, '')
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
    assert.match(doc.querySelector('article[data-failed=true]').textContent, /read-only access/)
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
