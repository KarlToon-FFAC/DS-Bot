import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { contactLabels, deliveryPhase } from '../src/client/communication-model.js'
import { createSource } from '../src/client/sources.js'

test('communication labels disambiguate same-name origins and never equate storage, Human read and AI admission', () => {
  const contacts = [
    { principalId: 'bot:a:j', displayName: 'Chief', homeInstanceId: 'a', instanceLabel: 'Office', kind: 'bot' },
    { principalId: 'bot:a:k', displayName: 'Chief', homeInstanceId: 'a', instanceLabel: 'Office', kind: 'bot' },
    { principalId: 'bot:b:j', displayName: 'Chief', homeInstanceId: 'b', instanceLabel: 'Office', kind: 'bot' },
  ]
  const labels = contactLabels(contacts, 'a')
  assert.equal(new Set(labels.values()).size, 3)
  assert.match(labels.get('bot:b:j'), /Remote/)
  assert.equal(deliveryPhase({ targetStored: 1 }), 'Destination stored')
  assert.equal(deliveryPhase({ targetStored: 1, uiApplied: 1 }), 'Displayed')
  assert.equal(deliveryPhase({ humanRead: 1 }), 'Read')
  assert.equal(deliveryPhase({ aiAccepted: 1 }), 'Bot admitted')
  assert.equal(deliveryPhase({ aiAccepted: 1, revoked: 1 }), 'Revoked')
})

const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = harness('jsdom')
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/client/communication.js', import.meta.url))],
  bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false })

test('production pane ignores a late history response and retries an uncertain HTTP send with the same persisted intent', async () => {
  const dom = new JSDOM('<!doctype html><body><textarea id="native">private draft</textarea><div id="root"></div></body>', { url: 'http://127.0.0.1:3101/', pretendToBeVisual: true })
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const React = harness('react'), { act } = React, { createRoot } = harness('react-dom/client')
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports,
    require: id => id === 'react' ? React : id === 'react-dom' ? harness('react-dom') : { MarkdownText: ({ text }) => React.createElement('p', null, text) },
    window: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage,
    setTimeout, clearTimeout, crypto: globalThis.crypto, AbortSignal, requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame })
  const panel = createSource(true), roster = createSource({ communicationEnabled: true }), surface = createSource({ mode: 'bot' })
  const member = id => ({ conversationId: id, title: id, kind: 'group', role: 'owner', speakingMode: 'speak', membershipEpoch: id, joinSeq: 1, watermark: 1, info: { members: [] } })
  const snapshot = { connected: true, instanceId: 'a', humanPrincipalId: 'human:a:A', contacts: [], conversations: [member('one'), member('two')], invites: [], outbox: [], errors: [] }
  const history = id => ({ conversationId: id, membershipEpoch: id, joinSeq: 1, watermark: 1, events: [{ eventId: id, type: 'membership.joined', conversationSeq: 1 }] })
  let releaseFirst
  const first = new Promise(resolve => { releaseFirst = resolve })
  const sends = []
  const request = async body => {
    if (body.endpoint === 'state') return snapshot
    if (body.endpoint === 'history') return body.conversationId === 'one' ? first : history('two')
    if (body.endpoint === 'read') return {}
    if (body.endpoint === 'send') { sends.push(body); if (sends.length === 1) throw new TypeError('network response lost'); return { status: 'pending' } }
    throw new Error('Unexpected request')
  }
  dom.window.sessionStorage.setItem('ds-bot:communication:selected', JSON.stringify('one'))
  const root = createRoot(dom.window.document.getElementById('root'))
  const field = () => dom.window.document.querySelector('.bt-comm-frame textarea')
  try {
    await act(async () => root.render(React.createElement(mod.exports.CommunicationSurface, { roster, surface, panel, request })))
    await act(async () => [...dom.window.document.querySelectorAll('nav button')].find(button => button.textContent === 'two').click())
    await act(async () => releaseFirst(history('one')))
    assert.equal(dom.window.document.querySelector('.bt-comm-main h2').textContent, 'two')
    assert.equal(dom.window.document.querySelectorAll('.bt-comm-log .bt-comm-event').length, 1)
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(field(), 'same original intent')
      field().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    let escaped = 0
    dom.window.document.addEventListener('keydown', () => { escaped += 1 })
    await act(async () => field().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.equal(field().disabled, true)
    assert.equal(sends.length, 1)
    assert.equal(escaped, 0)
    await act(async () => [...dom.window.document.querySelectorAll('footer>button')].find(button => button.textContent === 'Retry same send').click())
    assert.equal(sends.length, 2)
    assert.deepEqual(sends[0], sends[1])
    assert.equal(sends[0].conversationId, 'two')
    assert.equal(field().value, '')
    await act(async () => dom.window.document.getElementById('native').focus())
    assert.equal(dom.window.document.activeElement, field())
    assert.equal(dom.window.document.getElementById('native').value, 'private draft')
    snapshot.conversations[1].speakingMode = 'readOnly'
    await act(async () => { panel.set(false) })
    await act(async () => { panel.set(true) })
    assert.equal(field().disabled, true)
    assert.ok(dom.window.document.querySelector('.bt-comm-main').textContent.includes('You have read-only access to this group.'))
    snapshot.outbox = [{ type: 'message.publish', id: 'old-send', conversationId: 'two', state: 'pending', text: 'previous epoch local send' }]
    snapshot.conversations = []
    await act(async () => { panel.set(false) })
    await act(async () => { panel.set(true) })
    assert.equal(dom.window.document.querySelector('.bt-comm-log').textContent.includes('previous epoch local send'), false)
  } finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
})
