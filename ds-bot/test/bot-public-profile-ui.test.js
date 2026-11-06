import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = harness('jsdom'), React = harness('react'), { act } = React
const { outputFiles } = await build({ stdin: { contents: "export { BotPublicProfile } from './bot-settings.js'", resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'js' },
  bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false })

async function ui(check) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'https://local.example.test/' })
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  const mod = { exports: {} }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports, require: id => id === 'react' ? React : id === 'react-dom' ? harness('react-dom') : {},
    window: dom.window, document: dom.window.document, sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage, setTimeout, clearTimeout, URL })
  const { createRoot } = harness('react-dom/client'), root = createRoot(dom.window.document.getElementById('root')), doc = dom.window.document
  const render = async (bot, actions, open = true) => {await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(mod.exports.BotPublicProfile, { key: bot.id, bot, actions }))));if(open&&!doc.querySelector('dialog[open]'))await act(async()=>doc.querySelector('[aria-label="Edit remote profile"]').click())}
  const edit = async (label, value) => act(async () => {
    const node = doc.querySelector(`[aria-label="${label}"]`), kind = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement
    Object.getOwnPropertyDescriptor(kind.prototype, 'value').set.call(node, value)
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const save = async () => act(async () => doc.querySelector('[aria-label="Save public profile"]').click())
  try { await check({ doc, render, edit, save }) }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
}

test('Bot public profile stages changes, saves separately from instructions and retains edits made while saving', async () => {
  await ui(async ({ doc, render, edit, save }) => {
    const calls = []; let finish
    const actions = { updateBot: async (id, patch) => { calls.push({ id, patch }); return new Promise(resolve => { finish = resolve }) } }
    const bot = { id: 'bot-one', instructions: 'Private instructions' }
    await render(bot, actions)
    assert.equal(doc.querySelector('[aria-label="Save public profile"]').disabled, true)
    await edit('Public headline', 'Testing expert')
    await edit('Public skills', 'testing, regression， browser')
    assert.equal(calls.length, 0)
    await save()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].id, bot.id)
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].patch)), { expectedProfileRevision: 0,
      publicProfile: { headline: 'Testing expert', summary: '', expertise: ['testing', 'regression', 'browser'], languages: [] } })
    await edit('Public summary', 'New detail entered during save')
    await act(async () => finish({ publicProfile: { ...calls[0].patch.publicProfile, revision: 1 } }))
    assert.equal(doc.querySelector('[aria-label="Public summary"]').value, 'New detail entered during save')
    assert.equal(doc.querySelector('[aria-label="Save public profile"]').disabled, false)
    await save()
    assert.equal(calls[1].patch.expectedProfileRevision, 1)
    assert.equal(calls[1].patch.publicProfile.summary, 'New detail entered during save')
    await act(async () => finish({ publicProfile: { ...calls[1].patch.publicProfile, revision: 2 } }))
    assert.equal(doc.querySelector('[aria-label="Save public profile"]').disabled, true)
  })
})

test('concurrent roster refresh keeps a dirty draft and sends its original revision for conflict protection', async () => {
  await ui(async ({ doc, render, edit, save }) => {
    const calls = [], old = { id: 'bot-one', publicProfile: { headline: 'Original', revision: 1 } }
    const actions = { updateBot: async (_id, patch) => { calls.push(patch); throw new Error('Public profile changed elsewhere.') } }
    await render(old, actions)
    await edit('Public headline', 'My unsaved draft')
    await render({ ...old, publicProfile: { headline: 'Changed elsewhere', revision: 2 } }, actions)
    assert.equal(doc.querySelector('[aria-label="Public headline"]').value, 'My unsaved draft')
    await save()
    assert.equal(calls[0].expectedProfileRevision, 1)
    assert.equal(doc.querySelector('[aria-label="Public headline"]').value, 'My unsaved draft')
    assert.match(doc.querySelector('[role="alert"]').textContent, /changed elsewhere/)
  })
})

test('remote profile starts as a compact action and edits in a standalone dialog whose cancel never saves',async()=>{
 await ui(async({doc,render,edit})=>{
  let saves=0
  const bot={id:'tester',name:'Tester',publicProfile:{headline:'Current',summary:'Background',expertise:['Regression'],revision:1}}
  const actions={updateBot:async()=>{saves++;return {}}}
  await render(bot,actions,false)
  assert.equal(doc.querySelector('[aria-label="Public headline"]'),null)
  await act(async()=>doc.querySelector('[aria-label="Edit remote profile"]').click())
  const dialog=doc.querySelector('dialog[aria-label="Edit remote profile"]')
  assert.equal(dialog.parentElement,doc.body);assert.equal(dialog.open,true)
  assert.equal(dialog.querySelector('[aria-label="Public summary"]').value,'Background')
  assert.ok(dialog.querySelector('.bt-comm-operation-footer [aria-label="Save public profile"]'))
  await edit('Public summary','Unsaved background')
  await act(async()=>dialog.querySelector('[aria-label="Close dialog"]').click())
  assert.equal(saves,0)
  await act(async()=>doc.querySelector('[aria-label="Edit remote profile"]').click())
  assert.equal(dialog.querySelector('[aria-label="Public summary"]').value,'Background')
 })
})
