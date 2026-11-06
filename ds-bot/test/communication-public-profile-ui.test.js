import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = harness('jsdom'), React = harness('react'), { act } = React
const { outputFiles } = await build({ stdin: { contents: "export * from './communication-profile.js'", resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'js' },
  bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false })

async function ui(check) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'https://local.example.test/', pretendToBeVisual: true })
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports, require: id => id === 'react' ? React : id === 'react-dom' ? harness('react-dom') : {},
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, setTimeout, clearTimeout })
  const root = harness('react-dom/client').createRoot(dom.window.document.getElementById('root')), doc = dom.window.document
  const render = props => act(async () => root.render(React.createElement(mod.exports.HumanProfile, props)))
  const click = async label => {
    const node = [...doc.querySelectorAll('button')].find(button => button.textContent === label)
    assert.ok(node, label); await act(async () => node.click())
  }
  const edit = (label, value) => act(async () => {
    const node = doc.querySelector(`[aria-label="${label}"]`)
    assert.ok(node, label)
    const type = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement
    Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(node, value)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  try { await check({ doc, render, click, edit, unmount: () => act(async () => root.unmount()) }) }
  finally {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  }
}

const profile = { headline: 'Test lead', summary: 'Testing responsibilities', expertise: ['Testing'], languages: ['English'], version: 4 }
const human = { principalId: 'human:a:buddy', kind: 'human', displayName: 'Buddy', publicProfile: profile }
const plain = value => JSON.parse(JSON.stringify(value))

test('Human responsibilities save independently with a profile version and no caller-selected identity', async () => {
  await ui(async ({ doc, render, click, edit }) => {
    const calls = []; let current = profile
    const request = async body => { assert.equal(body.endpoint, 'human-profile-info'); return { principalId: human.principalId, publicProfile: current } }
    const operation = async (endpoint, body) => { calls.push({ endpoint, ...plain(body) }); current = { ...body.profile, version: 5 }; return { publicProfile: current } }
    await render({ human, request, operation })
    await edit('Role or specialty', '测试负责人')
    await edit('Profile summary', '负责测试策略和回归验证。')
    await edit('Expertise (comma-separated)', '测试, automation，测试')
    await edit('Languages (comma-separated)', '中文, English')
    await click('Save profile')
    assert.deepEqual(calls, [{ endpoint: 'profile-human-info', expectedVersion: 4, profile: {
      headline: '测试负责人', summary: '负责测试策略和回归验证。', expertise: ['测试', 'automation'], languages: ['中文', 'English'],
    } }])
    assert.equal(doc.querySelector('[aria-label="Save profile"]').disabled, true)
    assert.equal(doc.querySelector('[aria-label="Role or specialty"]').value, '测试负责人', 'a stale parent snapshot cannot replace an accepted edit')
  })
})

test('queued profile edits remain dirty and retry the same version and payload without claiming completion', async () => {
  await ui(async ({ doc, render, click, edit }) => {
    const calls = []; let completed = 0, current = profile
    const request = async () => ({ principalId: human.principalId, publicProfile: current })
    const operation = async (endpoint, body) => {
      calls.push({ endpoint, ...plain(body) })
      if (calls.length === 1) return { status: 'queued' }
      current = { ...body.profile, version: 5 }; return { publicProfile: current }
    }
    await render({ human, request, operation, onSaved: () => { completed += 1 } })
    await edit('Role or specialty', 'Automation lead')
    await click('Save profile')
    assert.equal(completed, 0)
    assert.equal(doc.querySelector('[aria-label="Save profile"]').dataset.dirty, 'true')
    assert.match(doc.querySelector('[role="alert"]').textContent, /not confirmed/)
    await click('Save profile')
    assert.deepEqual(calls[0], calls[1]); assert.equal(completed, 1)
  })
})

test('a profile conflict keeps the draft, reviews current data and avoids repeating an accepted name change', async () => {
  await ui(async ({ doc, render, click, edit }) => {
    const calls = []; let current = profile
    const operation = async (endpoint, body) => {
      calls.push({ endpoint, ...plain(body) })
      if (endpoint === 'profile-human') return { displayName: body.displayName }
      if (body.expectedVersion === 4) {
        current = { ...profile, headline: 'Remote updated title', version: 7 }
        throw Object.assign(new Error('PUBLIC_PROFILE_VERSION_CONFLICT'), { code: 'PUBLIC_PROFILE_VERSION_CONFLICT' })
      }
      current = { ...body.profile, version: 8 }; return { publicProfile: current }
    }
    const request = async body => {
      assert.equal(body.endpoint, 'human-profile-info')
      return { principalId: human.principalId, publicProfile: current }
    }
    await render({ human, request, operation })
    await edit('Human name', 'Buddy Test')
    await edit('Role or specialty', 'My unsaved responsibility')
    await click('Save profile')
    assert.equal(doc.querySelector('[aria-label="Role or specialty"]').value, 'My unsaved responsibility')
    assert.equal(doc.querySelector('[aria-label="Save profile"]').disabled, true)
    await click('Review latest profile')
    assert.match(doc.querySelector('[aria-label="Latest shared profile"]').textContent, /Remote updated title/)
    assert.equal(doc.querySelector('[aria-label="Role or specialty"]').value, 'My unsaved responsibility')
    await click('Save profile')
    assert.deepEqual(calls.map(call => call.endpoint), ['profile-human', 'profile-human-info', 'profile-human-info'])
    assert.equal(calls[2].expectedVersion, 7)
    assert.equal(doc.querySelector('[aria-label="Save profile"]').disabled, true)
  })
})

test('a truncated directory summary cannot be edited until the complete own profile is loaded', async () => {
  await ui(async ({ doc, render, click }) => {
    let attempts = 0
    const request = async body => {
      assert.equal(body.endpoint, 'human-profile-info')
      if (++attempts === 1) throw new Error('CONNECTION_LOST')
      return { principalId: human.principalId, publicProfile: { ...profile, summary: 'Complete summary from the canonical profile endpoint.' } }
    }
    const operation = async () => assert.fail('No update should be sent from incomplete profile data')
    await render({ human: { ...human, publicProfile: { ...profile, summary: 'Truncated…', truncated: true } }, request, operation })
    assert.equal(doc.querySelector('[aria-label="Profile summary"]').disabled, true)
    await click('Save profile')
    await click('Reload profile details')
    assert.equal(doc.querySelector('[aria-label="Profile summary"]').disabled, false)
    assert.equal(doc.querySelector('[aria-label="Profile summary"]').value, 'Complete summary from the canonical profile endpoint.')
    assert.equal(doc.querySelector('[aria-label="Save profile"]').disabled, true)
  })
})

test('a confirmed save survives a failed follow-up read and reloads without resending the edit', async () => {
  await ui(async ({ doc, render, click, edit }) => {
    let reads = 0, saves = 0, completed = 0, current = profile
    const request = async () => {
      if (++reads === 2) throw new Error('CONNECTION_LOST')
      return { principalId: human.principalId, publicProfile: current }
    }
    const operation = async (_endpoint, body) => {
      saves += 1; current = { ...plain(body.profile), version: 5 }; return { publicProfile: current }
    }
    await render({ human, request, operation, onSaved: () => { completed += 1 } })
    await edit('Role or specialty', 'Accepted responsibility')
    await click('Save profile')
    assert.equal(completed, 1)
    assert.equal(doc.querySelector('[aria-label="Role or specialty"]').value, 'Accepted responsibility')
    assert.equal(doc.querySelector('[aria-label="Role or specialty"]').disabled, true)
    assert.match(doc.body.textContent, /Profile saved, but the latest details could not be loaded/)
    await click('Reload profile details')
    assert.equal(doc.querySelector('[aria-label="Role or specialty"]').disabled, false)
    assert.equal(doc.querySelector('[aria-label="Save profile"]').disabled, true)
    assert.equal(saves, 1)
  })
})
