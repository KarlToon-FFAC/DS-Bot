import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = harness('jsdom'), React = harness('react'), { act } = React
const { outputFiles } = await build({ stdin: { contents: "export * from './communication-contacts.js'; export * from './communication-profile.js'", resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'js' },
  bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false })

async function ui(check) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'https://local.example.test/', pretendToBeVisual: true })
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports, require: id => id === 'react' ? React : id === 'react-dom' ? harness('react-dom') : {},
    window: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage, setTimeout, clearTimeout, crypto: globalThis.crypto, URL,
    requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame })
  const { createRoot } = harness('react-dom/client'), root = createRoot(dom.window.document.getElementById('root')), doc = dom.window.document
  const render = async node => act(async () => root.render(node))
  const click = async label => { const node = [...doc.querySelectorAll('button')].find(button => button.textContent === label); assert.ok(node, label); await act(async () => node.click()) }
  const edit = async (label, value) => act(async () => {
    const node = doc.querySelector(`[aria-label="${label}"]`)
    const kind = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement
    Object.getOwnPropertyDescriptor(kind.prototype, 'value').set.call(node, value)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  try { await check({ exports: mod.exports, dom, doc, render, click, edit }) }
  finally { await act(async () => root.unmount()); mod.exports.syncAvatarDirectory([]); dom.window.close(); for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
}

test('canonical ownership never reassigns a hidden owner to a visible Human on the same instance', async () => {
  await ui(async ({ exports: api }) => {
    const contacts = [
      { principalId: 'human:team:a', kind: 'human', displayName: 'Buddy', homeInstanceId: 'team' },
      { principalId: 'human:team:z', kind: 'human', displayName: 'Buddy', homeInstanceId: 'team' },
      { principalId: 'bot:team:canonical', kind: 'bot', homeInstanceId: 'team', ownerPrincipalId: 'human:team:z' },
      { principalId: 'bot:team:hidden', kind: 'bot', homeInstanceId: 'team', ownerPrincipalId: null },
      { principalId: 'bot:team:legacy', kind: 'bot', homeInstanceId: 'team' },
    ]
    const result = api.contactDirectory(contacts)
    assert.deepEqual(Array.from(result.people, entry => [entry.person.principalId, ...entry.bots.map(bot => bot.principalId)]), [
      ['human:team:a', 'bot:team:legacy'], ['human:team:z', 'bot:team:canonical'],
    ])
    assert.deepEqual(Array.from(result.otherBots, bot => bot.principalId), ['bot:team:hidden'])
  })
})

test('public profile search supports Chinese and normalized skill names without inheriting a Human role', async () => {
  await ui(async ({ exports: api }) => {
    const buddy = { principalId: 'human:team:buddy', kind: 'human', displayName: 'Buddy', publicProfile: { headline: '测试负责人', summary: '协调测试策略', expertise: ['质量管理'] } }
    const bot = { principalId: 'bot:team:one', kind: 'bot', displayName: 'Runner', publicProfile: { headline: '端到端测试', summary: '浏览器回归', expertise: ['Playwright'], languages: ['中文'] } }
    assert.equal(api.contactMatches(buddy, '质量管理'), true)
    assert.equal(api.contactMatches(bot, '浏览器'), true)
    assert.equal(api.contactMatches(bot, 'ＰＬＡＹＷＲＩＧＨＴ'), true)
    assert.equal(api.contactMatches(bot, '中文'), false)
    assert.equal(api.contactMatches(bot, '测试负责人'), false)
  })
})

test('contact lists show distinct Bot skills, safely render descriptions and preserve exact Message targets through filters', async () => {
  await ui(async ({ exports: api, doc, render, edit }) => {
    const contacts = [
      { principalId: 'human:team:buddy', kind: 'human', displayName: 'Buddy', homeInstanceId: 'team', publicProfile: { headline: 'Testing coordinator', summary: '<img src=x onerror=alert(1)>', expertise: ['Test strategy'] } },
      { principalId: 'bot:team:ui', kind: 'bot', displayName: 'UI runner', homeInstanceId: 'team', ownerPrincipalId: 'human:team:buddy', publicProfile: { headline: 'Browser tests', expertise: ['Playwright'] } },
      { principalId: 'bot:team:load', kind: 'bot', displayName: 'Load runner', homeInstanceId: 'team', ownerPrincipalId: 'human:team:buddy', publicProfile: { headline: 'Load testing', expertise: ['k6'] } },
    ]
    const sent = []
    await render(React.createElement(api.ContactDirectory, { contacts, relations: [], request: async () => ({}), onMessage: id => sent.push(id) }))
    const card = doc.querySelector('[data-contact-id="human:team:buddy"]')
    assert.ok(card)
    assert.match(card.textContent, /Testing coordinator/)
    assert.match(card.querySelector('[data-principal-id="bot:team:ui"]').textContent, /Playwright/)
    assert.doesNotMatch(card.querySelector('[data-principal-id="bot:team:ui"]').textContent, /Test strategy/)
    assert.equal(card.querySelector('.bt-comm-directory-about').open, false)
    assert.equal(doc.querySelector('img'), null)
    assert.ok(doc.body.textContent.includes('<img src=x onerror=alert(1)>'))
    await edit('Find a contact or Bot', 'k6')
    assert.equal(doc.querySelectorAll('[data-principal-id]').length, 1)
    await act(async () => doc.querySelector('[aria-label="Published Bots"]').click())
    assert.equal(doc.querySelector('[data-contact-id]'), null)
    assert.equal(doc.querySelectorAll('[data-principal-id]').length, 1)
    await act(async () => doc.querySelector('[data-principal-id="bot:team:load"] button').click())
    assert.deepEqual(sent, ['bot:team:load'])
  })
})
