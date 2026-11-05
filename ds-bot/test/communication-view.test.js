import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const requireHarness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = requireHarness('jsdom')
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../dev/communication/probe-plugin/client-source.js', import.meta.url))],
  bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom'], write: false,
})

test('P0 view keeps drafts in their conversation and Enter submits only to the Human projection', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://127.0.0.1:3101/' })
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const React = requireHarness('react')
  const { createRoot } = requireHarness('react-dom/client')
  const { act } = React
  const messages = { 'p0-group': [], 'p0-dm': [] }
  const requests = []
  const calls = []
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports, require: id => id === 'react-dom' ? requireHarness('react-dom') : React,
    sessionStorage: dom.window.sessionStorage, document: dom.window.document, setInterval, clearInterval,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body.operation)
      if (body.operation === 'view-send') { calls.push(body); messages[body.conversationId].push({ messageId: `m-${calls.length}`, author: 'You · Human', text: body.text }) }
      return { json: async () => ({ ok: true, value: { views: Object.fromEntries(Object.entries(messages).map(([id, list]) => [id, { messages: [...list], unread: 0 }])) } }) }
    },
  })
  const root = createRoot(dom.window.document.getElementById('root'))
  const field = () => dom.window.document.querySelector('textarea')
  const button = label => [...dom.window.document.querySelectorAll('nav button')].find(node => node.textContent === label)
  const edit = async text => act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(field(), text)
    field().dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  try {
    await act(async () => root.render(React.createElement(mod.exports.ProbePane)))
    assert.equal(dom.window.document.activeElement, field())
    await edit('group draft')
    await act(async () => button('Private message').click())
    assert.equal(field().value, '')
    await edit('private draft')
    await act(async () => button('Shared group').click())
    assert.equal(field().value, 'group draft')
    let escapedKeys = 0
    dom.window.document.addEventListener('keydown', () => { escapedKeys += 1 })
    await act(async () => field().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].conversationId, 'p0-group')
    assert.equal(calls[0].text, 'group draft')
    assert.equal(escapedKeys, 0)
    assert.equal(field().value, '')
    await act(async () => button('Private message').click())
    assert.equal(field().value, 'private draft')
    assert.ok(requests.every(operation => ['view', 'view-read', 'view-send'].includes(operation)))
    assert.equal(dom.window.sessionStorage.getItem('p0-conversation'), 'p0-dm')
    await act(async () => root.render(React.createElement(mod.exports.ProbeOverlay)))
    await act(async () => dom.window.document.querySelector('.p0-entry').click())
    const chief = dom.window.document.createElement('textarea')
    dom.window.document.body.prepend(chief)
    await act(async () => chief.focus())
    assert.equal(dom.window.document.activeElement, dom.window.document.querySelector('.p0-frame textarea'))
    await act(async () => dom.window.document.querySelector('.p0-navigation button').click())
    assert.equal(dom.window.document.querySelector('.p0-frame'), null)
    chief.remove()
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
