import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { managementPage, managementScript } from '../../communication-hub/src/management-ui.js'

const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function fixture(t) {
  const dom = new JSDOM(managementPage, { url: 'http://127.0.0.1:3190/admin/', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  const { window } = dom, calls = [], confirmations = []
  Object.defineProperty(window.document, 'visibilityState', { value: 'hidden' })
  let approve = false, release, pending = false
  const state = { requests: [], instances: [
    { instanceId: 'device-a', label: '<Untrusted device>', trusted: 1, pairingRevision: 1, nameVersion: 0, ownedSharedGroups: [{ conversationId: 'shared-one', title: '<Shared group>', version: 7 }] },
    { instanceId: 'device-b', label: 'Unrelated device', trusted: 0, revision: 2, pairingRevision: 2, nameVersion: 0, ownedSharedGroups: [] },
  ] }
  window.fetch = async (url, options) => {
    const action = url.split('/').at(-1), input = JSON.parse(options.body)
    if (action === 'session') return { ok: true, json: async () => ({ ok: true, csrf: 'synthetic-csrf' }) }
    calls.push({ action, input })
    if (action === 'delete') {
      if (pending) await new Promise(resolve => { release = resolve })
      state.instances = state.instances.filter(instance => instance.instanceId !== input.instanceId)
    }
    return { ok: true, json: async () => ({ ok: true, value: state, revision: 'synthetic' }) }
  }
  window.AbortSignal = AbortSignal
  window.confirm = text => { confirmations.push(text); return approve }
  window.eval(managementScript)
  const render = () => window.render(state)
  render()
  return { window, calls, state, confirmations, render, approve: () => { approve = true }, defer: () => { pending = true }, release: () => release() }
}

test('administrator delete UI distinguishes revoke, escapes untrusted names, lists exact group impact and cancels without mutation', async t => {
  const f = fixture(t), { document } = f.window
  const row = document.querySelector('#instances article')
  assert.match(row.textContent, /<Untrusted device>/)
  assert.equal(row.querySelector('untrusted'), null)
  assert.ok([...row.querySelectorAll('button')].some(button => button.textContent === 'Revoke access'))
  const button = [...row.querySelectorAll('button')].find(button => button.textContent === 'Delete device permanently')
  button.click(); await tick()
  assert.equal(f.calls.some(call => call.action === 'delete'), false)
  assert.match(f.confirmations[0], /This cannot be undone/)
  assert.match(f.confirmations[0], /Groups to close:\n<Shared group> \(shared-one\)/)
  assert.match(f.confirmations[0], /without assigning a new owner/)
  assert.equal(document.querySelectorAll('#instances article').length, 2)
  assert.equal(button.disabled, false)
})

test('administrator delete sends observed versions once, reconciles exact row and removes repair after permanent deletion', async t => {
  const f = fixture(t), { document } = f.window
  f.approve(); f.defer()
  const row = document.querySelector('#instances article')
  const button = [...row.querySelectorAll('button')].find(button => button.textContent === 'Delete device permanently')
  button.click(); button.click(); await tick()
  assert.equal(f.calls.filter(call => call.action === 'delete').length, 1)
  assert.equal(button.disabled, true)
  assert.deepEqual(f.calls.find(call => call.action === 'delete').input, { instanceId: 'device-a', expectedPairingRevision: 1, expectedNameVersion: 0, ownedSharedGroups: [{ conversationId: 'shared-one', version: 7 }], confirmDelete: true })
  f.release(); for(let i=0;i<30&&button.disabled;i++) await tick()
  assert.equal(document.querySelectorAll('#instances article').length, 1, document.querySelector('#error').textContent)
  assert.match(document.querySelector('#instances article').textContent, /Unrelated device/)
  assert.ok([...document.querySelectorAll('#instances button')].some(button => button.textContent === 'Repair original device'))
  f.state.instances = []; f.render()
  assert.equal(document.querySelector('#instances').textContent, 'No enrolled devices.')
  assert.equal([...document.querySelectorAll('#instances button')].some(button => button.textContent === 'Repair original device'), false)
})
