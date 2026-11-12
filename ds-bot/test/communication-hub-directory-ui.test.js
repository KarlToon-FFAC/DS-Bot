import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS, 'package.json'))('jsdom')
import { managementPage, managementScript } from '../../communication-hub/src/management-ui.js'

const participants = [
  { principalId: 'human:a:buddy', kind: 'human', displayName: 'Buddy', instanceLabel: 'Testing team', connected: true,
    publicProfile: { headline: 'Testing lead', summary: 'Coordinates release testing.', expertise: ['Quality assurance'], languages: ['English'] } },
  { principalId: 'bot:a:web', ownerPrincipalId: 'human:a:buddy', kind: 'bot', displayName: 'Web Tester', instanceLabel: 'Testing team',
    publicProfile: { headline: 'Browser testing', summary: '<script>untrusted()</script>', expertise: ['Playwright'], languages: ['English'] } },
  { principalId: 'bot:b:api', ownerPrincipalId: null, kind: 'bot', displayName: 'API Tester', instanceLabel: 'API team',
    publicProfile: { headline: 'API testing', expertise: ['HTTP'] } },
]

function fixture(t) {
  const dom = new JSDOM(managementPage, { url: 'http://127.0.0.1:3190/admin/', runScripts: 'outside-only' })
  t.after(() => dom.window.close())
  dom.window.fetch = async () => ({ ok: false, json: async () => ({ ok: false, error: { code: 'UNAUTHENTICATED' } }) })
  dom.window.eval(managementScript + '\nglobalThis.showDirectory = value => { csrf = "synthetic"; render({requests:[],instances:[],participants:value}); };')
  dom.window.showDirectory(participants)
  return dom.window
}

test('Hub contacts list shows each contact profile and only canonical owned Bots', t => {
  const window = fixture(t), doc = window.document
  assert.equal(doc.querySelectorAll('#directory-list [data-directory-id]').length, 1)
  assert.equal(doc.querySelector('#directory-profile').hidden, true)
  doc.querySelector('#directory-list [data-directory-id]').click()
  assert.equal(doc.querySelector('#directory-profile h3').textContent, 'Buddy')
  assert.match(doc.querySelector('#directory-profile').textContent, /Testing lead.*Coordinates release testing/s)
  assert.deepEqual([...doc.querySelectorAll('#directory-profile [data-directory-id]')].map(node => node.dataset.directoryId), ['bot:a:web'])
  assert.equal(doc.querySelector('#show-contacts').getAttribute('aria-pressed'), 'true')
  assert.equal(doc.querySelector('.directory-avatar').dataset.kind, 'human')
  const row=()=>doc.querySelector('#directory-list [data-directory-id]')
  assert.equal(row().getAttribute('aria-expanded'),'true')
  window.showDirectory(participants)
  assert.equal(row().getAttribute('aria-expanded'),'true','refresh retains expanded profile')
  row().click()
  assert.equal(doc.querySelector('#directory-profile').hidden,true)
  window.showDirectory(participants)
  assert.equal(row().getAttribute('aria-expanded'),'false','refresh must not reopen collapsed profile')
  assert.equal(doc.documentElement.lang,'zh-CN')
  assert.equal(doc.querySelector('#directory-title').textContent,'Hub 通讯录')
  assert.equal(doc.querySelector('#show-contacts').textContent,'联系人')
})

test('public Bot list supports skill search and treats profile content as text', t => {
  const window = fixture(t), doc = window.document
  doc.querySelector('#show-bots').click()
  assert.equal(doc.querySelectorAll('#directory-list [data-directory-id]').length, 2)
  const search = doc.querySelector('#directory-search')
  search.value = 'Playwright'; search.dispatchEvent(new window.Event('input'))
  assert.equal(doc.querySelector('#directory-count').textContent, '1 个 Bot')
  doc.querySelector('#directory-list [data-directory-id]').click()
  assert.equal(doc.querySelector('#directory-profile h3').textContent, 'Web Tester')
  assert.match(doc.querySelector('.directory-about').textContent, /<script>untrusted\(\)<\/script>/)
  assert.equal(doc.querySelector('#directory-profile script'), null)
  assert.equal(doc.querySelector('#show-bots').getAttribute('aria-pressed'), 'true')
  search.value = 'missing'; search.dispatchEvent(new window.Event('input'))
  assert.match(doc.querySelector('#directory-list').textContent, /没有匹配/)
})


test('Hub code view refuses an old backend response and only enables copying v2 codes', t => {
  const window = fixture(t), doc = window.document
  window.eval('globalThis.showCode = value => render({requests:[],instances:[],...value});')
  for (const value of [{code:'dsbot-hub:1:synthetic'}, {codeError:'HUB_V2_MIGRATION_REQUIRED'}]) {
    window.showCode(value)
    assert.equal(doc.getElementById('copy-code').disabled,true)
    assert.match(doc.getElementById('hub-code-status').textContent,/HUB_V2_MIGRATION_REQUIRED/)
    assert.doesNotMatch(doc.getElementById('code').textContent,/dsbot-hub:1:/)
  }
  window.showCode({code:'dsbot-hub:2:synthetic-test-code'})
  assert.equal(doc.getElementById('copy-code').disabled,false)
  assert.equal(doc.getElementById('code').textContent,'dsbot-hub:2:synthetic-test-code')
})
