import { conversationSummary } from './conversation-summary.js'
const fail = code => { throw Object.assign(new Error(code), { code }) }

function ownedBots(runtime) {
  return new Map([...(runtime.bots ?? [])].filter(([id]) => runtime.rt?.botOf?.(id)).map(([id, bot]) => [bot.principalId, id]))
}
function botDm(info) {
  return info?.kind === 'dm' && info.members?.length === 2 && info.members.every(person => person.kind === 'bot')
}
export function botDmRecords(runtime) {
  if (!runtime.everReconciled) return []
  const owned = ownedBots(runtime), records = new Map()
  for (const member of [...runtime.queue.memberships()].sort((a,b) => a.principalId.localeCompare(b.principalId))) {
    const info = runtime.conversations?.get(member.conversationId)
    if (member.kind !== 'dm' || !owned.has(member.principalId) || !botDm(info) || records.has(member.conversationId)) continue
    records.set(member.conversationId, { ...member, info, archive: true, viewerBotId: owned.get(member.principalId),
      viewerPrincipalId: member.principalId, unread: 0, lastMessage: conversationSummary(runtime.queue.lastMessage(member.conversationId, member.principalId, member.membershipEpoch), info.members) })
  }
  return [...records.values()]
}
export function botDmContext(runtime, input) {
  if (typeof input.membershipEpoch !== 'string') fail('MEMBERSHIP_EPOCH_REQUIRED')
  const bot = runtime.bots.get(input.localBotId)
  if (!bot || !runtime.rt.botOf(input.localBotId)) fail('BOT_NOT_PUBLISHED')
  const member = runtime.member(bot.principalId, input.conversationId, input.membershipEpoch)
  const info = runtime.conversations.get(input.conversationId)
  if (member.kind !== 'dm' || !botDm(info) || !info.members.some(person => person.principalId === bot.principalId)) fail('FORBIDDEN')
  return { member, principalId: bot.principalId, info }
}
export async function participantProfile(runtime, input) {
  const actor = input.localBotId === undefined ? runtime.human.principalId : botDmContext(runtime, input).principalId
  const info = await runtime.members(actor, input)
  if (!info.members.some(person => person.principalId === input.targetPrincipalId)) fail('NOT_A_MEMBER')
  const result = await runtime.transport.request('principal.public-profile.read', { principalId: actor, targetPrincipalId: input.targetPrincipalId })
  if (result.principalId !== input.targetPrincipalId || !result.publicProfile || result.publicProfile.truncated) fail('INVALID_PUBLIC_PROFILE_RESPONSE')
  return result
}
