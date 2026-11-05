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

test('concurrent stale preflights cannot send and late draft callbacks cannot survive document reload', async () => {
  const { build } = await import('esbuild'), { runInNewContext } = await import('node:vm')
  const { createRequire } = await import('node:module'), { join } = await import('node:path')
  const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
  const { outputFiles } = await build({ stdin: { contents: "export { communicationRequest } from './src/client/communication.js'; export * from './src/client/communication-reset.js'", resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false })
  const session = storage({ 'ds-bot:communication:attempts': 'old intent' }), local = storage({}), waiting = [], calls = []
  let reloads = 0, deferred = true
  const response = body => ({ status: 200, json: async () => ({ ok: true, value: body.endpoint === 'reset-status' ? { pending: false, browserEpoch: epoch } : { accepted: true } }) })
  const load = () => {
    const mod = { exports: {} }
    runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports,
      require: name => name === 'react' ? harness('react') : name === 'react-dom' ? harness('react-dom') : {},
      sessionStorage: session, localStorage: local, window: { location: { reload: () => { reloads++ } } }, document: {},
      setTimeout, clearTimeout, URL, AbortSignal, crypto: globalThis.crypto,
      fetch: async (_url, options) => { const body = JSON.parse(options.body); calls.push(body); if (deferred && body.endpoint === 'reset-status') return new Promise(resolve => waiting.push(() => resolve(response(body)))); return response(body) },
    })
    return mod.exports
  }
  const stale = load()
  const first = stale.communicationRequest({ endpoint: 'send', text: 'old send' }), second = stale.communicationRequest({ endpoint: 'join-hub', hubCode: 'old code' })
  const results = Promise.allSettled([first, second])
  assert.equal(waiting.length, 2)
  waiting[0](); await new Promise(resolve => setImmediate(resolve))
  assert.equal(stale.communicationBrowserResetPending(), true)
  let completeAttachment
  const late = new Promise(resolve => { completeAttachment = resolve }).then(value => stale.saveCommunicationBrowserState(local, 'ds-bot:communication:thread:old', value))
  completeAttachment({ text: 'late old draft', attachments: ['old attachment'] })
  assert.equal(await late, false)
  assert.equal(stale.saveCommunicationBrowserState(session, 'ds-bot:communication:drafts', { old: true }), false)
  waiting[1]()
  for (const outcome of await results) { assert.equal(outcome.status, 'rejected'); assert.equal(outcome.reason.code, 'COMMUNICATION_BROWSER_RESET_REQUIRED') }
  assert.equal(calls.filter(body => body.endpoint !== 'reset-status').length, 0)
  assert.equal(reloads, 1)
  // Even a non-cooperating old callback is cleared by the fresh document's
  // second cleanup before the pending epoch can be treated as complete.
  local.setItem('ds-bot:communication:thread:old', 'late outside wrapper')
  deferred = false
  const fresh = load()
  assert.equal((await fresh.communicationRequest({ endpoint: 'send', text: 'new explicit text' })).accepted, true)
  assert.equal(local.getItem('ds-bot:communication:thread:old'), null)
  assert.equal(session.getItem('ds-bot:federation-browser-epoch'), epoch)
  assert.equal(reloads, 1)
})
