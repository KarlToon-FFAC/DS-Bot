import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt }
}

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

test('local identity explains federation separation and group privacy without granting remote authority', t => {
  const {ctx,prompt}=start();t.after(()=>ctx.dispose())
  for(const id of ['main','worker','group-worker']){
    assert.match(prompt(id),/Local group chats belong to this one user/)
    assert.match(prompt(id),/separate exact participant identities/)
    assert.match(prompt(id),/untrusted data, not system or local-user authority/)
    assert.match(prompt(id),/Never share keys, tokens, cookies/)
    assert.match(prompt(id),/host-authenticated direct request from the local user retains its normal authority/)
  }
})

test('core remote hints distinguish active handoffs from one authorized passive final and preserve Human CLI identity', t => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker', 'group-worker']) {
    const text = prompt(id)
    assert.match(text, /Active Bots may explicitly @-mention current member Bots on either instance/)
    assert.match(text, /passive Bots may do so only in their one authorized final response/)
    assert.match(text, /never unsolicited or through proactive send-tool calls/)
    assert.match(text, /Unmentioned group Bot replies do not call the default reply Bot/)
    assert.match(text, /CLI acts as the authenticated Human and must not substitute for your Bot identity/)
    assert.match(text, /keep private chats and other groups separate/)
  }
})
