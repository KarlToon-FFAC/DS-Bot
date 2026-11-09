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


test('a known Chinese recipient plus an inline prose @ resolves only the actual member while explicit unknown recipients still fail',()=>{
 const contacts=[{principalId:'bot:b:beta',displayName:'贝塔',kind:'bot'}]
 assert.deepEqual(communicationMentions('@贝塔 你收到@你的消息了吗',contacts),[{principalId:'bot:b:beta'}])
 assert.deepEqual(communicationMentions('请@贝塔查看',contacts),[{principalId:'bot:b:beta'}])
 assert.throws(()=>communicationMentions('@陌生成员 你好',contacts),{code:'UNKNOWN_MENTION'})
 assert.throws(()=>communicationMentions('普通文字',contacts,['bot:b:removed']),{code:'UNKNOWN_MENTION'})
})

test('retired recipients have a dedicated error and @all only selects current Bots',()=>{
 const current={principalId:'bot:b:new',displayName:'Current',kind:'bot'}
 const retired={principalId:'bot:b:old',displayName:'Former',kind:'bot',retired:true}
 assert.throws(()=>communicationMentions('Hello',[current],[retired.principalId],{retired:[retired]}),{code:'BOT_RETIRED'})
 assert.throws(()=>communicationMentions('@Former hello',[current],[],{retired:[retired]}),{code:'BOT_RETIRED'})
 assert.throws(()=>communicationMentions('@Former hello',[current,retired]),{code:'BOT_RETIRED'})
 assert.deepEqual(communicationMentions('@all hello',[current,retired]),[{principalId:current.principalId}])
 assert.deepEqual(communicationMentions('Previously @Former helped',[current],[],{displayOnly:true,retired:[retired]}),[])
 const replacement={...current,displayName:'Former'}
 assert.deepEqual(communicationMentions('@Former hello',[replacement],[],{retired:[retired]}),[{principalId:replacement.principalId}])
 assert.throws(()=>communicationMentions('@Former hello',[replacement],[retired.principalId],{retired:[retired]}),{code:'BOT_RETIRED'})
})
