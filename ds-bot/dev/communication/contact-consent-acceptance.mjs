import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { hash } from '../../../communication-hub/src/protocol.js'
import { LocalTopology, until } from './local-topology.mjs'
import { repo } from './bench-client.mjs'

const nonce = randomUUID().slice(0, 8)
const topology = new LocalTopology({ prefix: `contact-consent-${nonce}`, webPort: 3265, mockPort: 8965, hubPort: 3269 })
const evidence = { status: 'RUNNING', model: 'deterministic Mock', cases: [] }
const record = name => { evidence.cases.push(name); console.log('PASS', name) }
async function login(peer) {
  const log = readFileSync(join(peer.home, 'web.log'), 'utf8')
  const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${peer.web}/\\?token=[^\\s]+`))?.[0]
  assert.ok(url, 'Owned test profile has a login URL')
  const result = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  peer.cookie = result.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
}
async function cli(peer, command, input = {}) {
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'].includes(key)))
    const child = spawn(process.execPath, [join(repo, 'ds-bot/bin/dsbot-remote.mjs'), command], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, DSBOT_REMOTE_URL: `http://127.0.0.1:${peer.web}`, DSBOT_REMOTE_COOKIE: peer.cookie },
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('CLI_TIMEOUT')) }, 60000)
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      try { resolve({ code, body: JSON.parse((code === 0 ? stdout : stderr).trim().split('\n').findLast(line => line.startsWith('{'))) }) }
      catch { reject(Error('CLI_INVALID_JSON')) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}
function database(work) {
  const db = new DatabaseSync(join(topology.root, `${topology.prefix}-hub.sqlite`))
  try { db.exec('PRAGMA busy_timeout=5000'); return work(db) } finally { db.close() }
}
try {
  await topology.initialize()
  const [a, b] = topology.peers
  await Promise.all(topology.peers.map(login))
  const userCode = (await b.api({ endpoint: 'user-code' })).userCode
  const input = { userCode, localBotIds: [], operationId: randomUUID() }
  const sent = await cli(a, 'request-contact', input)
  assert.equal(sent.code, 0, sent.body.error?.code)
  const incoming = (await b.api({ endpoint: 'contact-requests' })).find(item => item.requestId === sent.body.value.requestId)
  assert.equal(incoming?.direction, 'incoming')
  const accepted = await cli(b, 'accept-contact', { requestId: incoming.requestId, expectedVersion: incoming.version, localBotIds: [] })
  assert.equal(accepted.code, 0, accepted.body.error?.code)
  for (const peer of topology.peers) assert.equal((await peer.api({ endpoint: 'contact-relations' }))[0].botSharing, 'published')
  record('real-CLI-empty-localBotIds-request-and-accept-follow-published-Bots-on-both-sides')
  const group = await topology.group(`Consent ${nonce}`)
  const tag = `contact-consent-${nonce}`
  await topology.send(a, group, `COMM-ECHO ${tag}`, [b.bot])
  await until(() => topology.hasText(a, group, `Communication reply ${tag}`), 'published remote Bot joins and replies without CONTACT_REQUIRED', 60000)
  record('published-remote-Bot-can-join-group-and-reply-through-real-DSH-Mock')

  // Seed only the owned fixture database with the historical scope defect.
  database(db => {
    const row = db.prepare('SELECT * FROM hub_contacts WHERE left_id=? OR right_id=?').get(b.human, b.human)
    const column = row.left_id === b.human ? 'left_scope' : 'right_scope'
    db.prepare(`UPDATE hub_contacts SET ${column}='[]',epoch=?,version=version+1 WHERE pair=?`).run(randomUUID(), row.pair)
  })
  const broken = await cli(a, 'dm', { otherPrincipalId: b.bot })
  assert.notEqual(broken.code, 0); assert.equal(broken.body.error.code, 'CONTACT_REQUIRED')
  const relation = (await b.api({ endpoint: 'contact-relations' }))[0]
  assert.equal(relation.botSharing, 'none')
  const repaired = await cli(b, 'use-published-contact-bots', { otherHumanPrincipalId: a.human, expectedVersion: relation.version })
  assert.equal(repaired.code, 0, repaired.body.error?.code)
  assert.equal((await cli(a, 'dm', { otherPrincipalId: b.bot })).code, 0)
  record('legacy-empty-scope-is-visible-and-real-CLI-repair-restores-contact-permission')

  const before = database(db => db.prepare('SELECT count(*) n FROM hub_contact_requests').get().n)
  assert.equal((await cli(b, 'rotate-user-code')).code, 0)
  const invalid = await cli(a, 'request-contact', { userCode, operationId: randomUUID() })
  assert.notEqual(invalid.code, 0); assert.equal(invalid.body.error.code, 'CONTACT_CODE_UNAVAILABLE')
  assert.equal(database(db => db.prepare('SELECT count(*) n FROM hub_contact_requests').get().n), before)
  assert.equal((await cli(a, 'request-contact', input)).code, 0, 'An exact genuine retry preserves its original receipt')
  record('rotated-code-real-CLI-fails-without-new-row-and-genuine-original-retry-stays-idempotent')

  const ghost = { principalId: a.human, operationId: randomUUID(), userCode, sharePublishedBots: true }
  database(db => {
    db.prepare("INSERT INTO hub_contact_requests(id,sender,target,scope,status,expires_at) VALUES (?,?,NULL,'[]','pending',?)").run(ghost.operationId, a.human, Date.now() + 86400000)
    db.prepare('INSERT INTO hub_management_operations VALUES (?,?,?,?)').run(ghost.operationId, a.human, hash(ghost), JSON.stringify({ requestId: ghost.operationId, status: 'pending' }))
  })
  const retry = await cli(a, 'request-contact', { userCode, operationId: ghost.operationId })
  assert.notEqual(retry.code, 0); assert.equal(retry.body.error.code, 'CONTACT_CODE_UNAVAILABLE')
  assert.equal((await a.api({ endpoint: 'contact-requests' })).find(item => item.requestId === ghost.operationId).status, 'unavailable')
  record('legacy-target-null-request-and-success-receipt-no-longer-produce-permanent-pending')
  evidence.status = 'PASSED'
} catch (error) { evidence.status = 'FAILED'; evidence.error = error.code ?? error.message; throw error }
finally { await topology.close(); writeFileSync(join(topology.root, `${topology.prefix}-evidence.json`), JSON.stringify(evidence, null, 2)) }
