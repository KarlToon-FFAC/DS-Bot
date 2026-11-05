import assert from 'node:assert/strict'
import { test } from 'node:test'
import { communicationMentions } from '../src/shared/communication-mentions.js'
import { ALL_WORDS } from '../src/shared/mentions.js'

test('communication mentions resolve stable choices and never activate names in code, quotes, links, addresses or paths', () => {
  const contacts = [{ principalId: 'bot:a:J', displayName: 'Chief' }, { principalId: 'bot:b:K', displayName: 'Chief' },
    { principalId: 'human:b:B', displayName: 'Person B' }]
  assert.throws(() => communicationMentions('@Chief hello', contacts), { code: 'AMBIGUOUS_MENTION' })
  assert.deepEqual(communicationMentions('@Chief hello', contacts, ['bot:b:K']), [{ principalId: 'bot:b:K' }])
  assert.deepEqual(communicationMentions('@Person B hello', contacts), [{ principalId: 'human:b:B' }])
  assert.deepEqual(communicationMentions('`@Chief` [@Chief](https://example.test) a@Chief.test @Chief/file\n> @Chief\n```\n@Chief\n```', contacts), [])
  assert.throws(() => communicationMentions('@Missing hello', contacts), { code: 'UNKNOWN_MENTION' })
  assert.deepEqual(communicationMentions('@all hello', contacts), [{principalId:'bot:a:J'},{principalId:'bot:b:K'}])
  assert.deepEqual(communicationMentions('`@all`\n> @all',contacts),[])
})

test('reserved all-Bot mentions cannot be captured by Human or Bot display names', () => {
  for (const word of ALL_WORDS) {
    const contacts = [{ principalId: 'human:a:user', displayName: word, kind: 'human' },
      { principalId: 'human:b:user', displayName: `${word} review`, kind: 'human' },
      { principalId: 'bot:b:worker', displayName: 'Worker', kind: 'bot' }]
    assert.deepEqual(communicationMentions(`@${word} review`, contacts), [{ principalId: 'bot:b:worker' }])
    assert.deepEqual(communicationMentions(`\`@${word}\`\n> @${word}`, contacts), [])
    assert.deepEqual(communicationMentions('Exact identity notification', contacts, ['human:a:user']), [{ principalId: 'human:a:user' }])
  }
})
