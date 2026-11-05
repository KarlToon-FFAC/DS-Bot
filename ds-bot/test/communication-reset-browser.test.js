import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clearCommunicationBrowserState } from '../src/client/communication-reset.js'
const epoch = '00000000-0000-4000-8000-000000000001'
const storage = initial => {
  const map = new Map(Object.entries(initial))
  return { get length() { return map.size }, key: index => [...map.keys()][index], getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }
}
test('browser reset removes all Hub drafts/intents from both stores, preserves unrelated settings and is per tab', () => {
  const session = storage({ 'ds-bot:communication:drafts': 'synthetic old text', 'ds-bot:communication:thread:hubA:id': 'old', theme: 'dark' })
  const local = storage({ 'ds-bot:communication:attempts': 'old', model: 'keep' })
  assert.equal(clearCommunicationBrowserState(epoch, session, local), true)
  assert.equal(session.getItem('ds-bot:communication:drafts'), null); assert.equal(local.getItem('ds-bot:communication:attempts'), null)
  assert.equal(session.getItem('theme'), 'dark'); assert.equal(local.getItem('model'), 'keep')
  assert.equal(clearCommunicationBrowserState(epoch, session, local), false)
  const otherTab = storage({ 'ds-bot:communication:operation-ids': 'pending' })
  assert.equal(clearCommunicationBrowserState(epoch, otherTab, local), true)
  assert.equal(otherTab.getItem('ds-bot:communication:operation-ids'), null)
})
test('unavailable storage fails without marking cleanup complete', () => {
  const session = storage({ 'ds-bot:communication:drafts': 'old' }), local = storage({})
  session.removeItem = () => { throw new Error('synthetic browser denial') }
  assert.throws(() => clearCommunicationBrowserState(epoch, session, local))
  assert.equal(session.getItem('ds-bot:federation-browser-epoch'), null)
})

test('production request preflight clears browser memory before any old mutation can reach a reset Host', async () => {
  const { build } = await import('esbuild'), { runInNewContext } = await import('node:vm')
  const { createRequire } = await import('node:module'), { join } = await import('node:path')
  const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
  const { outputFiles } = await build({ entryPoints: [new URL('../src/client/communication.js', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false })
  const session = storage({ 'ds-bot:communication:attempts': 'old intent' }), local = storage({ 'ds-bot:communication:drafts': 'old draft' }), calls = []
  let reloads = 0
  const load = () => {
    const mod = { exports: {} }
    runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports,
      require: name => name === 'react' ? harness('react') : name === 'react-dom' ? harness('react-dom') : {},
      sessionStorage: session, localStorage: local, window: { location: { reload: () => { reloads++ } } }, document: {},
      setTimeout, clearTimeout, URL, AbortSignal, crypto: globalThis.crypto,
      fetch: async (_url, options) => { const body = JSON.parse(options.body); calls.push({ body, headers: options.headers }); return { status: 200, json: async () => ({ ok: true, value: body.endpoint === 'reset-status' ? { pending: false, browserEpoch: epoch } : { accepted: true } }) } },
    })
    return mod.exports.communicationRequest
  }
  const stale = load()
  await assert.rejects(stale({ endpoint: 'send', text: 'old pending text' }), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' })
  assert.equal(reloads, 1); assert.equal(calls.length, 1); assert.equal(calls[0].body.endpoint, 'reset-status')
  await assert.rejects(stale({ endpoint: 'send' }), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' })
  assert.equal(calls.length, 1, 'old page remains fenced until its code and memory reload')
  const fresh = load(), value = await fresh({ endpoint: 'send', text: 'new explicit message' })
  assert.equal(value.accepted, true); assert.equal(calls.at(-1).headers['x-dsbot-browser-epoch'], epoch)
})
