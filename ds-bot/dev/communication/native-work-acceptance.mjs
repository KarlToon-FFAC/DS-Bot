import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'

const nonce = randomUUID().slice(0, 8)
const topology = new LocalTopology({ prefix: `native-work-${nonce}`, webPort: 3255, mockPort: 8955, hubPort: 3259 })
const evidence = { status: 'RUNNING', model: 'deterministic Mock', cases: [] }
const record = name => { evidence.cases.push(name); console.log('PASS', name) }
try {
  await topology.initialize()
  const [a, b] = topology.peers
  const directory = join(topology.root, `native-work-${nonce}-workspace`)
  mkdirSync(directory, { recursive: true })
  await b.client.request('/api/bot', { endpoint: 'update-bot', payload: { id: b.botId, workDir: directory, permission: 'danger-full-access' } })
  const conversation = await topology.group(`Native work ${nonce}`)
  const run = async tag => {
    await topology.send(a, conversation, `COMM-WORK ${tag}`, [b.bot])
    return until(async () => {
      const { events } = await topology.history(a, conversation)
      return events.find(event => event.message?.author.principalId === b.bot && event.message.content.text.includes(tag) && /^Remote work /.test(event.message.content.text))?.message.content.text
    }, `remote work final ${tag}`, 90000)
  }
  const first = await run(nonce)
  assert.equal(first, `Remote work completed ${nonce}`)
  assert.equal(readFileSync(join(directory, `native-work-${nonce}.txt`), 'utf8'), `after:${nonce}`)
  assert.equal(readFileSync(join(directory, `native-shell-${nonce}.txt`), 'utf8').trim(), `shell:${nonce}`)
  record('remote-group-task-runs-native-file-read-write-edit-search-and-shell-in-owning-bot-directory')
  const { events } = await topology.history(a, conversation)
  assert.equal(events.filter(event => event.message?.author.principalId === b.bot && event.message.content.text === first).length, 1)
  assert.ok(!events.some(event => event.message?.content.text.includes('Created file') || event.message?.content.text.includes('Command finished')))
  record('native-tool-receipts-stay-local-and-only-useful-final-is-published')
  await a.client.request('/api/bot', { endpoint: 'send', payload: { sessionId: a.botId, text: `COMM-WORK-SEND ${b.bot} bot-${nonce}` } })
  const dm = await until(async () => (await a.api({ endpoint: 'state' })).botConversations.find(item => item.info.members.some(person => person.principalId === b.bot)), 'local Bot opens a work DM to the remote Bot', 45000)
  await until(async () => (await a.api({ endpoint: 'bot-dm-history', conversationId: dm.conversationId, membershipEpoch: dm.membershipEpoch, localBotId: a.botId })).events.some(event => event.message?.content.text === `Remote work completed bot-${nonce}`), 'remote expert completes the Bot-initiated work task', 60000)
  assert.equal(readFileSync(join(directory, `native-shell-bot-${nonce}.txt`), 'utf8').trim(), `shell:bot-${nonce}`)
  record('local-Bot-delegates-native-work-to-remote-expert-in-a-Bot-only-DM-and-receives-result')
  await topology.bench(b, 'stop'); await topology.startPeer(b)
  assert.equal(await run(`restart-${nonce}`), `Remote work completed restart-${nonce}`)
  record('native-work-directory-and-permission-inheritance-survive-host-restart')
  const moved = join(topology.root, `native-work-${nonce}-moved-workspace`)
  mkdirSync(moved, { recursive: true })
  await b.client.request('/api/bot', { endpoint: 'update-bot', payload: { id: b.botId, workDir: moved } })
  assert.equal(await run(`moved-${nonce}`), `Remote work completed moved-${nonce}`)
  assert.equal(readFileSync(join(moved, `native-work-moved-${nonce}.txt`), 'utf8'), `after:moved-${nonce}`)
  assert.equal(existsSync(join(directory, `native-work-moved-${nonce}.txt`)), false)
  record('changed-Bot-directory-creates-new-remote-segment-with-the-correct-immutable-root')
  const state = await b.client.request('/api/bot', { endpoint: 'state' })
  assert.ok(state.permissions.options.some(item => item.value === 'read-only'))
  await b.client.request('/api/bot', { endpoint: 'update-bot', payload: { id: b.botId, permission: 'read-only' } })
  const denied = await run(`denied-${nonce}`)
  assert.equal(denied, `Remote work failed denied-${nonce}`)
  assert.equal(existsSync(join(moved, `native-work-denied-${nonce}.txt`)), false)
  record('local-read-only-permission-change-denies-remote-mutation-before-side-effects')
  for (const choice of ['reject', 'allow']) {
    const tag = `${choice}-${nonce}`
    await topology.send(a, conversation, `COMM-WORK-APPROVAL ${tag}`, [b.bot])
    const pending = await until(async () => {
      const value = await b.api({ endpoint: 'state' })
      const approval = value.workApprovals.find(item => item.detail?.code === `native-approval-${tag}.txt`)
      return approval && { ...approval, expectedScope: value.conversationPreferencesScope }
    }, 'native work approval reaches the local Human', 45000)
    assert.equal(pending.conversationId, conversation)
    assert.equal(pending.sourceAuthorPrincipalId, a.human)
    assert.equal(pending.detail.workDirectory, moved)
    await assert.rejects(b.api({ endpoint: 'answer-work-approval', id: pending.id, choice, expectedScope: 'wrong-hub' }), error => error.code === 'HUB_SELECTION_CHANGED' || error.message.includes('HUB_SELECTION_CHANGED'))
    await b.api({ endpoint: 'answer-work-approval', id: pending.id, choice, expectedScope: pending.expectedScope })
    await until(() => topology.hasText(a, conversation, `Remote approval ${tag} ${choice === 'allow' ? 'accepted' : 'rejected'}`), 'one exact local approval outcome', 45000)
    assert.equal(existsSync(join(moved, `native-approval-${tag}.txt`)), choice === 'allow')
    record(`native-local-Human-${choice}-one-file-escalation-without-changing-Bot-permission`)
  }
  evidence.status = 'PASSED'
} catch (error) { evidence.status = 'FAILED'; evidence.error = error.message; throw error }
finally {
  await topology.close()
  writeFileSync(join(topology.root, `native-work-${nonce}-evidence.json`), JSON.stringify(evidence, null, 2))
}
