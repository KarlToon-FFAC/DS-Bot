import assert from 'node:assert/strict'
import { test } from 'node:test'
import { communicationMentions } from '../src/shared/communication-mentions.js'

test('communication mentions resolve stable choices and never activate names in code, quotes, links, addresses or paths', () => {
  const contacts = [{ principalId: 'bot:a:J', displayName: 'Chief' }, { principalId: 'bot:b:K', displayName: 'Chief' },
    { principalId: 'human:b:B', displayName: 'Person B' }]
  assert.throws(() => communicationMentions('@Chief hello', contacts), { code: 'AMBIGUOUS_MENTION' })
  assert.deepEqual(communicationMentions('@Chief hello', contacts, ['bot:b:K']), [{ principalId: 'bot:b:K' }])
  assert.deepEqual(communicationMentions('@Person B hello', contacts), [{ principalId: 'human:b:B' }])
  assert.deepEqual(communicationMentions('`@Chief` [@Chief](https://example.test) a@Chief.test @Chief/file\n> @Chief\n```\n@Chief\n```', contacts), [])
  assert.throws(() => communicationMentions('@Missing hello', contacts), { code: 'UNKNOWN_MENTION' })
  assert.throws(() => communicationMentions('@all hello', contacts), { code: 'UNSUPPORTED_CAPABILITY' })
})
