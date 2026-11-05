import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { managementPage, managementScript } from '../../communication-hub/src/management-ui.js'

const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json')), { JSDOM } = harness('jsdom')
const drain = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }

test('Hub admin applies change hints automatically, preserves name drafts/focus/version, and pauses hidden views', async () => {
  const dom = new JSDOM(managementPage, { url: 'http://127.0.0.1:3190/admin/', pretendToBeVisual: true })
  const doc = dom.window.document, calls = [], mutations = [], waits = []
  let hidden = false, revision = 'synthetic:1', value = { code: '', requests: [], instances: [{ instanceId: 'one', label: 'Original', trusted: 1, connected: true, nameVersion: 0 }] }
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' })
  const fetch = async (_url, options) => {
    const action = _url.split('/').at(-1), input = JSON.parse(options.body); calls.push(action)
    if (action === 'session') return { ok: true, json: async () => ({ ok: true, csrf: 'synthetic-csrf' }) }
    assert.equal(options.headers['x-csrf-token'], 'synthetic-csrf')
    if (action === 'state') return { ok: true, json: async () => ({ ok: true, revision, value: structuredClone(value) }) }
    if (action === 'changes') return new Promise((resolve, reject) => {
      const waiter = { finish: () => resolve({ ok: true, json: async () => ({ ok: true, revision }) }) }; waits.push(waiter)
      options.signal.addEventListener('abort', () => reject(Object.assign(Error('Aborted'), { name: 'AbortError' })), { once: true })
    })
    if (action === 'rename') { mutations.push(input); return { ok: false, json: async () => ({ ok: false, error: { code: 'INSTANCE_NAME_VERSION_CONFLICT' } }) } }
    throw Error('Unexpected action ' + action)
  }
  runInNewContext(managementScript, { document: doc, window: dom.window, navigator: dom.window.navigator, fetch, location: dom.window.location, confirm: () => true,
    setTimeout, clearTimeout, AbortController, AbortSignal, Math })
  try {
    await drain()
    assert.equal(doc.getElementById('content').hidden, false)
    const input = doc.querySelector('[aria-label="Instance name (one)"]')
    input.value = 'Unsaved draft'; input.focus()
    value.instances[0] = { ...value.instances[0], label: 'External name', nameVersion: 1, connected: false }; revision = 'synthetic:2'
    value.requests.push({ requestId: 'join', label: 'Synthetic applicant', status: 'pending', version: 1, fingerprint: 'SYNTHETIC' })
    waits.shift().finish(); await new Promise(resolve => setTimeout(resolve, 140)); await drain()
    assert.match(doc.getElementById('instances').textContent, /External name.*Disconnected from Hub/)
    assert.match(doc.getElementById('requests').textContent, /Synthetic applicant/)
    assert.equal(doc.querySelector('[aria-label="Instance name (one)"]'), input)
    assert.equal(input.value, 'Unsaved draft'); assert.equal(doc.activeElement, input)
    input.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await drain()
    assert.deepEqual(mutations, [{ instanceId: 'one', label: 'Unsaved draft', expectedNameVersion: 0 }])
    assert.match(doc.getElementById('error').textContent, /Device name changed elsewhere/)
    hidden = true; doc.dispatchEvent(new dom.window.Event('visibilitychange')); await drain()
    const before = calls.length; await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(calls.length, before)
    hidden = false; doc.dispatchEvent(new dom.window.Event('visibilitychange')); await drain()
    assert.equal(calls.filter(action => action === 'state').length, 3)
  } finally { dom.window.dispatchEvent(new dom.window.Event('pagehide')); await drain(); dom.window.close() }
})

test('Hub admin expires a live session without continuing to display approved devices as current', async () => {
  const dom = new JSDOM(managementPage, { url: 'http://127.0.0.1:3190/admin/', pretendToBeVisual: true })
  let changes = 0
  const fetch = async url => {
    const action = url.split('/').at(-1)
    if (action === 'session') return { ok: true, json: async () => ({ ok: true, csrf: 'synthetic' }) }
    if (action === 'state') return { ok: true, json: async () => ({ ok: true, revision: 'synthetic:1', value: { code: '', requests: [], instances: [] } }) }
    assert.equal(action, 'changes'); changes++
    return { ok: false, json: async () => ({ ok: false, error: { code: 'UNAUTHENTICATED' } }) }
  }
  runInNewContext(managementScript, { document: dom.window.document, window: dom.window, navigator: dom.window.navigator, fetch, location: dom.window.location, confirm: () => true,
    setTimeout, clearTimeout, AbortController, AbortSignal, Math })
  try {
    await drain()
    assert.equal(changes, 1)
    assert.equal(dom.window.document.getElementById('content').hidden, true)
    assert.equal(dom.window.document.getElementById('login').hidden, false)
    assert.match(dom.window.document.getElementById('error').textContent, /Sign in again/)
  } finally { dom.window.dispatchEvent(new dom.window.Event('pagehide')); await drain(); dom.window.close() }
})
