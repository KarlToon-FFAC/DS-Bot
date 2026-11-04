import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { communicationCSS } from '../src/client/communication-styles.js'
import { messageMentionSpans, communicationLogEvents } from '../src/client/communication-model.js'
const members = [
  { principalId: 'bot:a:chief', kind: 'bot', displayName: 'Chief', homeInstanceId: 'a', avatar: { color: 'pink', shape: 'star' } },
  { principalId: 'bot:b:chief', kind: 'bot', displayName: 'Chief', homeInstanceId: 'b' },
  { principalId: 'bot:a:review', kind: 'bot', displayName: 'Reviewer' },
  { principalId: 'human:a:all', kind: 'human', displayName: 'all' },
]
const message = (text, ids = ['bot:a:chief']) => ({ content: { text }, mentions: ids.map(principalId => ({ principalId })) })
test('inline mentions require exact structured IDs, current names and unambiguous targets', () => {
  assert.equal(messageMentionSpans(message('@Chief'), members)[0].people[0].principalId, 'bot:a:chief')
  for (const value of [message('@Chief', []), message('@Chief', ['bot:a:chief', 'bot:b:chief']), message('@Chief', ['bot:unknown:chief']), message('@Former')]) assert.deepEqual(messageMentionSpans(value, members), [])
  assert.deepEqual(messageMentionSpans(message('@Chief'), members.slice(1)), [])
  assert.ok(messageMentionSpans(message('@all', members.map(person => person.principalId)), members)[0].people.every(person => person.kind === 'bot'))
  assert.deepEqual(messageMentionSpans(message('@all', ['human:a:all']), members), [])
  for (const text of ['`@Chief`', '``@Chief``', '```md\n@Chief\n```', '~~~md\n@Chief\n~~~', '> @Chief\nquoted @Chief', '    @Chief', '[@Chief](https://example.test/a(b))', '[@Chief][ref]\n[ref]: https://example.test', '<https://example.test/@Chief>', '\\@Chief', '$@Chief$', '![image @Chief](https://example.test/image.png)', '<img src="https://example.test/@Chief">']) assert.deepEqual(messageMentionSpans(message(text), members), [], text)
})
const started = { type: 'bot.work.started', eventId: 'bot-work-started:d1', deliveryId: 'd1', messageId: 'm1', principalId: 'bot:a:chief', serverStartedAt: '2026-11-04T00:00:00.000Z' }
test('work-start history requires canonical events and deduplicates durable IDs', () => {
  const events = [{ type: 'message', message: message('Hello') }, { type: 'receipt', aiAccepted: true }, started, structuredClone(started), { ...started, eventId: 'invented' }, { ...started, eventId: 'bot-work-started:d2', deliveryId: 'd2', principalId: 'human:a:all' }]
  assert.deepEqual(communicationLogEvents(events), [events[0], started])
})
const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = harness('jsdom'), React = harness('react'), { act } = React
// The harness supplies platform primitives in product; here an anchor-producing
// adapter exercises portal ownership and keyboard behavior without replacing Markdown in product.
const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/client/communication-message.js', import.meta.url))], bundle: true, platform: 'browser', format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false })
async function ui(check) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'https://local.example.test/', pretendToBeVisual: true })
  const saved = Object.fromEntries(['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const mod = { exports: {} }, markdown = []
  const MarkdownText = ({ text }) => { markdown.push(text); const children = []; let start = 0; for (const match of text.matchAll(/\[([^\]\n]*)\]\((https:\/\/[^\s)]+)\)/g)) { children.push(text.slice(start, match.index), React.createElement('a', { key: match.index, href: match[2] }, match[1])); start = match.index + match[0].length } children.push(text.slice(start)); return React.createElement('p', null, ...children) }
  runInNewContext(outputFiles[0].text, { module: mod, exports: mod.exports, require: id => id === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText } : harness(id), window: dom.window, document: dom.window.document, navigator: dom.window.navigator, sessionStorage: dom.window.sessionStorage, localStorage: dom.window.localStorage, setTimeout, clearTimeout, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams, performance, requestAnimationFrame: dom.window.requestAnimationFrame, cancelAnimationFrame: dom.window.cancelAnimationFrame })
  const root = harness('react-dom/client').createRoot(dom.window.document.getElementById('root'))
  try { await check({ api: mod.exports, markdown, dom, doc: dom.window.document, render: async node => act(async () => root.render(node)) }) }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
}
test('inline avatar portals retain Markdown source and only inspect authorized targets', async () => {
  await ui(async ({ api, doc, dom, markdown, render }) => {
    const inspected = [], requests = [], props = { members, request: async body => { requests.push(body); return {} }, onInspect: ids => inspected.push(ids) }
    await render(React.createElement(api.CommunicationMessage, { ...props, message: message('Please **ask @Chief** and @Reviewer.\n\n- retain this list\n\n`literal code`', ['bot:a:chief', 'bot:a:review']) }))
    assert.equal(doc.querySelectorAll('.bt-comm-inline-mention').length, 2)
    assert.ok(doc.querySelector('.bt-comm-inline-mention .bt-mark'))
    assert.match(markdown.at(-1), /Please \*\*ask \[.*\*\* and/)
    assert.match(markdown.at(-1), /- retain this list/); assert.match(markdown.at(-1), /`literal code`/)
    assert.equal(doc.querySelectorAll('.bt-comm-inline-mention[href]').length, 0)
    await act(async () => doc.querySelector('.bt-comm-inline-mention').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    assert.deepEqual(inspected.map(ids => Array.from(ids)), [['bot:a:chief']])
    assert.equal(requests.length, 0)
    const forged = 'https://remote-mentions.dsbot.invalid/guessed/0'
    await render(React.createElement(api.CommunicationMessage, { ...props, message: message(`[@Chief](${forged})\n\n> @Chief\n\n\`@Chief\`\n\n@Former\n\n<img src="https://example.test/private.png">`) }))
    assert.equal(doc.querySelectorAll('a.bt-comm-inline-mention').length, 0)
    assert.equal(doc.querySelector('a').href, forged)
    assert.equal(doc.querySelectorAll('img').length, 0)
    assert.match(markdown.at(-1), /> @Chief/); assert.match(markdown.at(-1), /`@Chief`/)
    // Image markup is passed through unchanged and never becomes a participant chip.
    // The public renderer's existing external image behavior is checked in browser.
    await render(React.createElement(api.CommunicationMessage, { ...props, message: message('![image @Chief](https://example.test/image.png)\n\n[![nested @Chief](https://example.test/two.png)](https://example.test)') }))
    assert.equal(doc.querySelectorAll('a.bt-comm-inline-mention').length, 0)
    assert.match(markdown.at(-1), /!\[image @Chief\]/)
  })
})
test('started rows use current Bot metadata only and never pretend to be currently running', async () => {
  await ui(async ({ api, doc, render }) => {
    const inspected = [], props = { event: started, members, request: async () => { throw new Error('No image fetch') }, onInspect: ids => inspected.push(ids) }
    await render(React.createElement(api.BotWorkStarted, props))
    assert.match(doc.body.textContent, /Chief.*started on it/); assert.ok(doc.querySelector('.bt-mark'))
    assert.match(doc.querySelector('button').getAttribute('aria-label'), /Chief.*started on it.*View participant/)
    await act(async () => doc.querySelector('button').click())
    assert.deepEqual(inspected.map(ids => Array.from(ids)), [['bot:a:chief']])
    await render(React.createElement(api.BotWorkStarted, { ...props, members: [] }))
    assert.equal(doc.body.textContent, 'Bot started on it'); assert.equal(doc.querySelector('button'), null); assert.equal(doc.querySelector('[aria-busy]'), null)
  })
})

test('unmatched canonical current targets remain visible for renames, ambiguous names and manual Humans without duplication', async () => {
  await ui(async ({ api, doc, markdown, render }) => {
    const inspected = [], request = async () => { throw new Error('No mutation or external avatar request') }
    const renderMessage = async value => render(React.createElement(api.CommunicationMessage, { message: value, members, request, onInspect: ids => inspected.push(ids) }))
    for (const [text, ids] of [['@Former', ['bot:a:chief']], ['@Chief', ['bot:a:chief', 'bot:b:chief']], ['all please check', ['human:a:all']]]) {
      await renderMessage(message(text, ids))
      assert.equal(markdown.at(-1), text, 'original ambiguous or historical text stays unchanged')
      assert.deepEqual([...doc.querySelectorAll('.bt-comm-unmatched-mention')].map(node => node.dataset.mentionPrincipalId), ids)
      assert.equal(doc.querySelectorAll('.bt-comm-unmatched-mention .bt-comm-avatar').length, ids.length)
      assert.equal(doc.querySelectorAll('a.bt-comm-inline-mention').length, 0)
      await act(async () => doc.querySelector('.bt-comm-unmatched-mention').click())
      assert.deepEqual(Array.from(inspected.at(-1)), [ids[0]])
    }
    await renderMessage(message('@Chief', ['bot:a:chief', 'bot:a:chief']))
    assert.equal(doc.querySelectorAll('a.bt-comm-inline-mention').length, 1)
    assert.equal(doc.querySelectorAll('.bt-comm-unmatched-mention').length, 0)
    await renderMessage(message('@all', ['bot:a:chief', 'bot:b:chief', 'bot:a:review', 'human:a:all']))
    assert.equal(doc.querySelectorAll('a.bt-comm-inline-mention').length, 1)
    assert.deepEqual([...doc.querySelectorAll('.bt-comm-unmatched-mention')].map(node => node.dataset.mentionPrincipalId), ['human:a:all'], 'the All Bots chip already covers its exact Bot targets')
    await renderMessage(message('@Chief', ['bot:removed:chief', 'bot:removed:chief']))
    assert.equal(doc.querySelectorAll('.bt-comm-inline-mention').length, 0, 'removed targets cannot borrow directory metadata')
    await renderMessage(message('@Chief', []))
    assert.equal(doc.querySelectorAll('.bt-comm-inline-mention').length, 0, 'unstructured text cannot create a target')
    await renderMessage(message('all', ['human:a:all', 'human:a:all']))
    assert.equal(doc.querySelectorAll('.bt-comm-unmatched-mention').length, 1, 'duplicate canonical IDs render once')
  })
})

test('inline and unmatched mention labels supply the inherited text baseline while avatars center independently', async () => {
  await ui(async ({ api, doc, render }) => {
    const props = { members, request: async () => ({}), onInspect() {} }
    await render(React.createElement('div', { className: 'bt-comm-body', style: { fontSize: 22, lineHeight: '32px', fontWeight: 700 } },
      React.createElement('style', null, communicationCSS),
      React.createElement(api.CommunicationMessage, { ...props, message: message('Before **@Chief @Reviewer** after\n\n- List text\n\n`@Chief`', ['bot:a:chief', 'bot:a:review', 'human:a:all']) })))
    const labels = doc.querySelectorAll('.bt-comm-mention-label')
    assert.equal(labels.length, 3)
    assert.equal(doc.querySelectorAll('a.bt-comm-inline-mention .bt-comm-mention-label').length, 2)
    assert.equal(doc.querySelectorAll('button.bt-comm-unmatched-mention .bt-comm-mention-label').length, 1)
    for (const label of labels) {
      assert.equal(label.children.length, 0, 'the label is an independent text-only range for baseline measurement')
      assert.ok(label.previousElementSibling.classList.contains('bt-comm-avatar'))
      assert.equal(label.parentElement.className, 'bt-comm-inline-mention-content')
      const control = label.closest('.bt-comm-inline-mention')
      assert.ok(control.getAttribute('aria-label').startsWith('View participant:'))
    }
    const rules = [...doc.styleSheets[0].cssRules]
    const style = selector => rules.find(rule => rule.selectorText === selector).style
    const control = style('.bt-comm-body .bt-comm-inline-mention')
    assert.equal(control.getPropertyValue('font'), 'inherit')
    assert.equal(control.getPropertyValue('vertical-align'), 'baseline')
    assert.equal(control.getPropertyValue('align-items'), 'baseline')
    assert.equal(Number.parseFloat(control.getPropertyValue('min-height')), 0)
    assert.equal(style('.bt-comm-inline-mention-content').getPropertyValue('align-items'), 'baseline')
    assert.equal(style('.bt-comm-mention-label').getPropertyValue('font'), 'inherit')
    assert.equal(style('.bt-comm-mention-label').getPropertyValue('line-height'), 'inherit')
    assert.equal(style('.bt-comm-inline-mention .bt-comm-avatar').getPropertyValue('align-self'), 'center')
  })
})
