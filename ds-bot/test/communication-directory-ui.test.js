import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = harness('jsdom'), React = harness('react'), { act } = React
const { outputFiles } = await build({ stdin: { contents: "export * from './communication-contacts.js'; export * from './communication-profile.js'; export * from './communication-onboarding.js'; export * from './communication-list.js'; export { BotMark } from './mark.js'", resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)), loader: 'js' },
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
const imageA = 'data:image/png;base64,aA==', imageB = 'data:image/webp;base64,Yg=='

test('small single/group Chinese avatars remain one character with bounded glyphs, while Bot shapes remain local',async()=>{
  await ui(async({exports:api,doc,render})=>{
    const members=[{principalId:'human:a:one',kind:'human',displayName:'张三'},{principalId:'human:b:two',kind:'human',displayName:'𠮷田'}]
    for(const size of [12,16,24,36]){
      await render(React.createElement(api.ConversationAvatar,{conversation:{kind:'group',info:{members}},humanId:'none',request:async()=>({}),size}))
      assert.deepEqual([...doc.querySelectorAll('.bt-comm-avatar')].map(node=>node.dataset.initials),['张','𠮷'])
      for(const avatar of doc.querySelectorAll('.bt-comm-avatar')){assert.equal(avatar.style.overflow,'hidden');assert.ok(parseFloat(avatar.style.fontSize)<=12)}
    }
    await render(React.createElement(api.CommunicationAvatar,{person:{principalId:'human:a:english',kind:'human',displayName:'Alice'},request:async()=>({}),size:16}))
    assert.equal(doc.querySelector('.bt-comm-avatar').dataset.initials,'AL')
  })
})

test('different Hubs cannot share avatar cache or pending results even for identical claimed principal and revision',async()=>{
  await ui(async({exports:api,doc,render})=>{
    const person={principalId:'human:same:one',kind:'human',displayName:'张三',avatar:{imageRevision:'same-revision'}}
    let finishA,finishB,calls=0
    const request=()=>new Promise(resolve=>{if(++calls===1)finishA=resolve;else finishB=resolve})
    api.syncAvatarDirectory([person],'hub-A');await render(React.createElement(api.CommunicationAvatar,{person,request}))
    api.syncAvatarDirectory([person],'hub-B');await render(React.createElement(api.CommunicationAvatar,{person,request}))
    await act(async()=>finishA({image:imageA}));assert.equal(doc.querySelector('img'),null)
    await act(async()=>finishB({image:imageB}));assert.equal(doc.querySelector('img').getAttribute('src'),imageB)
    assert.equal(calls,2);api.syncAvatarDirectory([])
  })
})

test('avatars use local Bot shapes, name-derived Human defaults and only safe raster data', async () => {
  await ui(async ({ exports: api, doc, render }) => {
    assert.equal(api.safeAvatarImage(imageA), imageA)
    for (const value of ['https://remote.example/avatar.png', 'data:image/svg+xml;base64,PHN2Zz4=', imageA + 'a'.repeat(160000)]) assert.equal(api.safeAvatarImage(value), null)
    const bot = { id: 'local-one', color: 'blue', avatar: { shape: 'star' } }
    await render(React.createElement(React.Fragment, null,
      React.createElement(api.CommunicationAvatar, { person: { principalId: 'bot:a:one', kind: 'bot', displayName: 'One', avatar: { seed: bot.id, color: bot.color, shape: bot.avatar.shape } }, request: async () => { throw new Error('No image request') } }),
      React.createElement(api.BotMark, { bot, size: 28 })))
    const marks = doc.querySelectorAll('.bt-mark')
    assert.equal(marks.length, 2)
    assert.equal(marks[0].dataset.shape, marks[1].dataset.shape)
    assert.deepEqual([...marks[0].querySelectorAll('[fill]')].map(node => node.getAttribute('fill')), [...marks[1].querySelectorAll('[fill]')].map(node => node.getAttribute('fill')))
    await render(React.createElement(api.CommunicationAvatar, { person: { principalId: 'human:a:one', kind: 'human', displayName: 'Alice' }, request: async () => ({}) }))
    assert.equal(doc.querySelector('.bt-comm-avatar').dataset.initials, 'AL')
    await render(React.createElement(api.CommunicationAvatar, { person: { principalId: 'human:a:one', kind: 'human', displayName: 'Bob' }, request: async () => ({}) }))
    assert.equal(doc.querySelector('.bt-comm-avatar').dataset.initials, 'BO')
  })
})

test('avatar revision races cannot overwrite a newer image and revoked directories discard the cache', async () => {
  await ui(async ({ exports: api, doc, render }) => {
    const a = { principalId: 'human:a:one', kind: 'human', displayName: 'Person', avatar: { imageRevision: 'a'.repeat(64) } }, b = { ...a, avatar: { imageRevision: 'b'.repeat(64) } }
    const calls = []; let releaseA, releaseB
    const request = body => { calls.push(body); return calls.length === 1 ? new Promise(resolve => { releaseA = resolve }) : calls.length === 2 ? new Promise(resolve => { releaseB = resolve }) : Promise.resolve({ image: imageB }) }
    api.syncAvatarDirectory([a]); await render(React.createElement(api.CommunicationAvatar, { person: a, request }))
    api.syncAvatarDirectory([b]); await render(React.createElement(api.CommunicationAvatar, { person: b, request }))
    await act(async () => releaseB({ image: imageB }))
    await act(async () => releaseA({ image: imageA }))
    assert.equal(doc.querySelector('img').getAttribute('src'), imageB)
    api.syncAvatarDirectory([]); await render(React.createElement(api.CommunicationAvatar, { person: b, request, allowed: false }))
    assert.equal(doc.querySelector('img'), null)
    api.syncAvatarDirectory([b]); await render(React.createElement(api.CommunicationAvatar, { person: b, request }))
    assert.equal(calls.length, 3)
    assert.equal(calls[2].principalId, b.principalId)
    assert.equal(calls[2].revision, b.avatar.imageRevision)
  })
})

test('Human profile stages name, upload and reset behind one dirty Save without sending a caller identity', async () => {
  await ui(async ({ exports: api, doc, dom, render, click, edit }) => {
    const calls = [], human = { principalId: 'human:a:one', displayName: 'Alice', kind: 'human' }
    const operation = async (endpoint, body) => { calls.push({ endpoint, ...body }); return { displayName: body.displayName } }
    await render(React.createElement(api.HumanProfile, { human, request: async () => ({}), operation, convertImage: async () => imageA }))
    assert.equal(doc.querySelector('[aria-label="Save profile"]').disabled, true)
    await edit('Human name', 'Renamed')
    const file = doc.querySelector('input[type=file]')
    Object.defineProperty(file, 'files', { configurable: true, value: [new dom.window.File(['raster'], 'avatar.png', { type: 'image/png' })] })
    await act(async () => file.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
    assert.equal(calls.length, 0)
    assert.equal(doc.querySelector('[alt="Avatar preview"]').getAttribute('src'), imageA)
    await click('Save profile')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].endpoint, 'profile-human')
    assert.equal(calls[0].displayName, 'Renamed')
    assert.equal(calls[0].avatar.image, imageA)
    assert.equal(Object.hasOwn(calls[0], 'principalId'), false)
    await click('Reset avatar')
    assert.equal(calls.length, 1)
    assert.equal(doc.querySelector('[aria-label="Save profile"]').dataset.dirty, 'true')
    await click('Save profile')
    assert.equal(calls[1].avatar, null)
    assert.equal(Object.hasOwn(calls[1], 'displayName'), false)
  })
})

test('Hub code review reveals the actual address and storage before a Human explicitly submits or cancels a join', async () => {
  await ui(async ({ exports: api, doc, render, click, edit }) => {
    const calls = [], hub = { version: 1, hubId: 'hub-one', url: 'wss://hub.example.test:3190/communication' }
    const request = async body => {
      calls.push(body)
      if (body.endpoint === 'onboarding-storage') return { storage: { defaultProvider: 'owner-acl-plaintext', encryptedByDefault: false, agentIsolation: false }, enrollments: [] }
      if (body.endpoint === 'decode-hub-code') return hub
      if (body.endpoint === 'join-hub') return { ...hub, status: 'pending', requestId: 'join-one' }
      if (body.endpoint === 'cancel-hub-join') return { ...hub, status: 'cancelled', requestId: 'join-one' }
      throw new Error('Unexpected endpoint')
    }
    await render(React.createElement(api.AddDevice, { request, manualGuide: React.createElement('p', null, 'Manual steps') }))
    assert.deepEqual(calls.map(call => call.endpoint), ['onboarding-storage'])
    assert.match(doc.body.textContent, /plaintext protected by your OS account permissions/)
    await edit('Hub code', 'owner-provided-code')
    await click('Review Hub')
    assert.match(doc.body.textContent, /wss:\/\/hub.example.test:3190\/communication/)
    assert.equal(doc.querySelector('a'), null, 'a Hub code does not prove a management server is enabled')
    assert.equal(calls.some(call => call.endpoint === 'join-hub'), false)
    await edit('Device display name', 'New machine')
    await click('Confirm and request access')
    const join = calls.find(call => call.endpoint === 'join-hub')
    assert.equal(join.confirmedHubId, hub.hubId)
    assert.equal(join.confirmedUrl, hub.url)
    assert.equal(join.displayName, 'New machine')
    assert.equal(Object.hasOwn(join, 'credential'), false)
    assert.equal(Object.hasOwn(join, 'principalId'), false)
    await click('Cancel request')
    assert.equal(calls.at(-1).endpoint, 'cancel-hub-join')
    assert.equal(calls.at(-1).hubId, hub.hubId)
    assert.equal(api.hubManagementAddress('http://untrusted.example/'), null)
  })
})

test('contact requests and acceptance share no Bots by default and always use exact locally owned IDs', async () => {
  await ui(async ({ exports: api, doc, render, click, edit }) => {
    const mutations = [], available = { bots: [{ id: 'local-one', name: 'One' }, { id: 'local-two', name: 'Two' }], publishedBotIds: ['local-one'] }
    const request = async body => {
      if (body.endpoint === 'user-code') return { userCode: 'ABCD-EF12' }
      if (body.endpoint === 'available-bots') return available
      if (body.endpoint === 'contact-requests') return [{ requestId: 'incoming', direction: 'incoming', status: 'pending', senderName: 'Other person', senderPrincipalId: 'human:b:other', version: 4 }]
      if (body.endpoint === 'contact-relations') return []
      throw new Error('Unexpected read')
    }
    const operation = async (endpoint, body) => { mutations.push({ endpoint, ...body }); return {} }
    await render(React.createElement(api.ContactManager, { request, operation, contacts: [] }))
    assert.equal([...doc.querySelectorAll('input[type=checkbox]')].filter(node => node.closest('fieldset').querySelector('legend').textContent.startsWith('Bots to share')).some(node => node.checked), false)
    await edit('Other user code', 'OTHER-CODE')
    await click('Request contact')
    assert.deepEqual([...mutations[0].localBotIds], [])
    await click('Accept contact')
    assert.equal(mutations[1].requestId, 'incoming')
    assert.equal(mutations[1].expectedVersion, 4)
    assert.deepEqual([...mutations[1].localBotIds], [])
    const outgoing = [...doc.querySelectorAll('fieldset')].find(node => node.querySelector('legend').textContent === 'Bots to share with this request')
    await act(async () => outgoing.querySelector('input').click())
    await edit('Other user code', 'NEXT-CODE')
    await click('Request contact')
    assert.deepEqual([...mutations[2].localBotIds], ['local-one'])
    assert.equal(Object.hasOwn(mutations[2], 'principalId'), false)
    const publication = [...doc.querySelectorAll('details')].find(node => node.querySelector('summary').textContent === 'Published Bots')
    await act(async () => publication.querySelector('summary').click())
    await act(async () => publication.querySelector('[data-local-bot-id="local-two"]').click())
    await click('Save published Bots')
    assert.equal(mutations[3].endpoint, 'publish-bots')
    assert.deepEqual([...mutations[3].localBotIds], ['local-one', 'local-two'])
  })
})


test('contact rejection, cancellation, code rotation and revocation stay explicit and versioned', async () => {
  await ui(async ({ exports: api, render, click }) => {
    const mutations = []
    const request = async body => {
      if (body.endpoint === 'user-code') return { userCode: 'ABCD-EF12' }
      if (body.endpoint === 'available-bots') return { bots: [], publishedBotIds: [] }
      if (body.endpoint === 'contact-requests') return [
        { requestId: 'incoming', direction: 'incoming', status: 'pending', senderName: 'Other', senderPrincipalId: 'human:b:other', version: 3 },
        { requestId: 'outgoing', direction: 'outgoing', status: 'pending', version: 5 },
      ]
      if (body.endpoint === 'contact-relations') return [{ otherHumanPrincipalId: 'human:c:friend', active: true, version: 7, botPrincipalIds: [] }]
      throw new Error('Unexpected endpoint')
    }
    const operation = async (endpoint, body) => { mutations.push({ endpoint, ...body }); return {} }
    await render(React.createElement(api.ContactManager, { request, operation, contacts: [] }))
    await click('Reject contact')
    assert.equal(mutations[0].endpoint, 'reject-contact')
    assert.equal(mutations[0].expectedVersion, 3)
    await click('Cancel request')
    assert.equal(mutations[1].endpoint, 'cancel-contact')
    assert.equal(mutations[1].expectedVersion, 5)
    await click('Rotate user code')
    assert.equal(mutations.length, 2)
    await click('Confirm code rotation')
    assert.equal(mutations[2].endpoint, 'rotate-user-code')
    await click('Remove contact')
    assert.equal(mutations.length, 3)
    await click('Confirm contact removal')
    assert.equal(mutations[3].endpoint, 'revoke-contact')
    assert.equal(mutations[3].otherHumanPrincipalId, 'human:c:friend')
    assert.equal(mutations[3].expectedVersion, 7)
  })
})

test('Hub approval is checked explicitly and invalidated code review cannot submit an older decoded Hub', async () => {
  await ui(async ({ exports: api, doc, render, click, edit }) => {
    const hub = { hubId: 'pending-hub', url: 'wss://hub.example.test/communication', status: 'pending', requestId: 'pending-request' }, calls = []
    let resolveDecode
    const request = async body => {
      calls.push(body)
      if (body.endpoint === 'onboarding-storage') return { enrollments: [hub], storage: { defaultProvider: 'owner-acl-plaintext' } }
      if (body.endpoint === 'hub-join-status') return { ...hub, status: 'approved' }
      if (body.endpoint === 'decode-hub-code') return new Promise(resolve => { resolveDecode = resolve })
      throw new Error('Unexpected endpoint')
    }
    await render(React.createElement(api.AddDevice, { request }))
    assert.equal(calls.some(call => call.endpoint === 'hub-join-status'), false)
    await click('Check approval')
    assert.match(doc.body.textContent, /Approved. The device configuration is saved/)
    await edit('Hub code', 'first-code')
    await click('Review Hub')
    await edit('Hub code', 'different-code')
    await act(async () => resolveDecode(hub))
    assert.equal([...doc.querySelectorAll('button')].some(node => node.textContent === 'Confirm and request access'), false)
    assert.equal(calls.some(call => call.endpoint === 'join-hub'), false)
  })
})


test('contact directory keeps stable Human/Bot ownership behind one IP and separates each side of sharing', async () => {
  await ui(async ({ exports: api, doc, render, edit }) => {
    const contacts = [
      { principalId: 'human:local:owner', kind: 'human', displayName: 'Me', homeInstanceId: 'local' },
      { principalId: 'bot:local:mine', kind: 'bot', displayName: 'My Bot', homeInstanceId: 'local' },
      { principalId: 'human:a:owner', kind: 'human', displayName: 'Same name', homeInstanceId: 'a', instanceLabel: 'Office A', ipAddress: '192.0.2.1' },
      { principalId: 'bot:a:one', kind: 'bot', displayName: 'Chief', homeInstanceId: 'a', instanceLabel: 'Office A' },
      { principalId: 'human:b:owner', kind: 'human', displayName: 'Same name', homeInstanceId: 'b', instanceLabel: 'Office B', ipAddress: '192.0.2.1' },
      { principalId: 'bot:b:one', kind: 'bot', displayName: 'Chief', homeInstanceId: 'b', instanceLabel: 'Office B' },
    ]
    const relations = [{ otherHumanPrincipalId: 'human:a:owner', active: true, botPrincipalIds: ['bot:local:mine'], version: 7 }], sent = []
    const directory = api.contactDirectory(contacts, relations, 'human:local:owner')
    assert.deepEqual([...directory.people].map(item => [item.person.principalId, ...item.bots.map(bot => bot.principalId)]), [
      ['human:a:owner', 'bot:a:one'], ['human:b:owner', 'bot:b:one'],
    ])
    await render(React.createElement(api.ContactDirectory, { contacts, relations, humanPrincipalId: 'human:local:owner', instanceId: 'local', request: async () => ({}), onMessage: id => sent.push(id) }))
    const card = doc.querySelector('[data-contact-id="human:a:owner"]')
    assert.match(card.textContent, /Office A/)
    assert.doesNotMatch(card.querySelector('.bt-comm-contact-bots').textContent, /My Bot|Office B/)
    assert.match(card.querySelector('dl').textContent, /Bots you share with this contactMy Bot/)
    assert.equal(doc.querySelector('[data-contact-id="human:local:owner"]'), null)
    await act(async () => card.querySelector('[data-principal-id="bot:a:one"] button').click())
    assert.deepEqual(sent, ['bot:a:one'])
    await edit('Find a contact or Bot', 'Office B')
    assert.equal(doc.querySelectorAll('[data-contact-id]').length, 1)
    assert.equal(doc.querySelector('[data-contact-id]').dataset.contactId, 'human:b:owner')
    await edit('Find a contact or Bot', 'No such person')
    assert.match(doc.querySelector('[role=status]').textContent, /No matching contacts or Bots/)
    assert.equal(sent.length, 1, 'filtering never creates a conversation')
  })
})

test('management defaults to contacts while requests, add forms and publication are separate disclosures', async () => {
  await ui(async ({ exports: api, doc, render }) => {
    const calls = [], contacts = [{ principalId: 'human:a:owner', kind: 'human', displayName: 'Alice', homeInstanceId: 'a' }]
    const request = async body => { calls.push(body.endpoint); return body.endpoint === 'user-code' ? { userCode: 'MY-CODE' } : body.endpoint === 'available-bots' ? { bots: [], publishedBotIds: [] } : body.endpoint === 'contact-requests' ? [{ requestId: 'pending', status: 'pending', direction: 'incoming', senderName: 'Visitor', version: 1 }] : [] }
    await render(React.createElement(api.ContactManager, { contacts, request, operation: async () => assert.fail('opening is read-only') }))
    assert.ok(doc.querySelector('[data-contact-id="human:a:owner"]'))
    const sections = [...doc.querySelectorAll('.bt-comm-contact-section')]
    assert.equal(sections.length, 3)
    assert.ok(sections.every(section => !section.open))
    const pending = sections.find(section => section.querySelector('summary').textContent.startsWith('Contact requests'))
    assert.equal(pending.querySelector('.bt-comm-count').textContent, '1')
    await act(async () => pending.querySelector('summary').click())
    assert.equal(pending.open, true)
    assert.equal(sections[0].open, false)
    assert.equal(calls.length, 4)
  })
})

test('a contact version conflict reloads terminal requests and relations without replaying the mutation', async () => {
  await ui(async ({ exports: api, doc, render, click }) => {
    let resolved = false, reads = 0
    const mutations = [], request = async body => {
      reads++
      if (body.endpoint === 'user-code') return { userCode: 'MY-CODE' }
      if (body.endpoint === 'available-bots') return { bots: [], publishedBotIds: [] }
      if (body.endpoint === 'contact-relations') return resolved ? [{ otherHumanPrincipalId: 'human:a:owner', active: true, botPrincipalIds: [], version: 2 }] : []
      return [{ requestId: 'incoming', direction: 'incoming', senderName: 'Alice', senderPrincipalId: 'human:a:owner', version: resolved ? 2 : 1, status: resolved ? 'accepted' : 'pending' }]
    }
    const operation = async (endpoint, body) => { mutations.push({ endpoint, ...body }); resolved = true; throw Object.assign(new Error('conflict'), { code: 'CONTACT_VERSION_CONFLICT' }) }
    await render(React.createElement(api.ContactManager, { request, operation, contacts: [] }))
    await click('Accept contact')
    assert.equal(mutations.length, 1)
    assert.equal(reads, 8, 'one complete read refresh after the conflict')
    assert.equal([...doc.querySelectorAll('button')].some(button => button.textContent === 'Accept contact'), false)
    assert.match(doc.querySelector('.bt-comm-contact-section:nth-of-type(2)').textContent, /accepted/)
    assert.ok(doc.querySelector('[data-contact-id="human:a:owner"]'))
    assert.ok(doc.querySelector('[role=alert]'))
  })
})


test('legacy multi-Human devices follow binary principal ordering and never assign bots by matching labels', async () => {
  await ui(async ({ exports: api }) => {
    const people = [
      { principalId: 'human:legacy:a', kind: 'human', displayName: 'Same', homeInstanceId: 'legacy' },
      { principalId: 'human:legacy:B', kind: 'human', displayName: 'Same', homeInstanceId: 'legacy' },
      { principalId: 'bot:legacy:one', kind: 'bot', displayName: 'Same', homeInstanceId: 'legacy' },
      { principalId: 'bot:unknown:one', kind: 'bot', displayName: 'Same', homeInstanceId: 'unknown' },
    ]
    const result = api.contactDirectory(people, [])
    assert.equal(result.people[0].person.principalId, 'human:legacy:B')
    assert.equal(result.people[0].bots[0].principalId, 'bot:legacy:one')
    assert.equal(result.people[1].bots.length, 0)
    assert.equal(result.otherBots[0].principalId, 'bot:unknown:one')
  })
})
