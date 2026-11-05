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
  assert.equal(doc.querySelector('#directory-profile h3').textContent, 'Buddy')
  assert.match(doc.querySelector('#directory-profile').textContent, /Testing lead.*Coordinates release testing/s)
  assert.deepEqual([...doc.querySelectorAll('#directory-profile [data-directory-id]')].map(node => node.dataset.directoryId), ['bot:a:web'])
  assert.equal(doc.querySelector('#show-contacts').getAttribute('aria-pressed'), 'true')
  assert.equal(doc.querySelector('.directory-avatar').dataset.kind, 'human')
})

test('public Bot list supports skill search and treats profile content as text', t => {
  const window = fixture(t), doc = window.document
  doc.querySelector('#show-bots').click()
  assert.equal(doc.querySelectorAll('#directory-list [data-directory-id]').length, 2)
  const search = doc.querySelector('#directory-search')
  search.value = 'Playwright'; search.dispatchEvent(new window.Event('input'))
  assert.equal(doc.querySelector('#directory-count').textContent, '1 Bots')
  assert.equal(doc.querySelector('#directory-profile h3').textContent, 'Web Tester')
  assert.match(doc.querySelector('.directory-about').textContent, /<script>untrusted\(\)<\/script>/)
  assert.equal(doc.querySelector('#directory-profile script'), null)
  assert.equal(doc.querySelector('#show-bots').getAttribute('aria-pressed'), 'true')
  search.value = 'missing'; search.dispatchEvent(new window.Event('input'))
  assert.match(doc.querySelector('#directory-list').textContent, /No matching/)
})
