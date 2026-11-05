// Seed only an explicitly named disposable UI acceptance group via public API.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { benchClient, repo } from './bench-client.mjs'

const conversationId = process.argv[2]
assert.match(conversationId ?? '', /^[0-9a-f-]{36}$/)
const client = await benchClient('communication-a', 3101)
const api = body => client.request('/api/communication', body)
const member = (await api({ endpoint: 'state' })).conversations.find(item => item.conversationId === conversationId)
assert.match(member?.title ?? '', /^UI acceptance /)
assert.equal(member.routingMode, 'mentionsOnly')
const sent = []
for (let index = 1; index <= 55; index++) {
  const messageId = randomUUID(), text = `Pagination marker ${String(index).padStart(2, '0')}`
  await api({ endpoint: 'send', conversationId, messageId, text, mentions: [], clientCreatedAt: new Date().toISOString() })
  sent.push({ messageId, text })
}
const text = `Long Markdown boundary\n\n${'完整内容🙂'.repeat(4000)}\n\nEND-OF-LONG-MESSAGE-1103`
const messageId = randomUUID()
await api({ endpoint: 'send', conversationId, messageId, text, mentions: [], clientCreatedAt: new Date().toISOString() })
writeFileSync(join(repo, '.dsh-test-tools/p3-ui-seed.json'), JSON.stringify({ conversationId, messages: sent, long: { messageId, chars: text.length, bytes: Buffer.byteLength(text), tail: 'END-OF-LONG-MESSAGE-1103' } }, null, 2))
console.log('Seeded 55 pagination messages and one complete long body; synthetic local UI group only.')
