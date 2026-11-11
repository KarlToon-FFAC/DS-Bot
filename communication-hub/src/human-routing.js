// Pure routing policy shared by Hub delivery and the bundled client preview.
// Authorization, publication and causal budgets remain the Hub's responsibility.
export function humanReceivingBots({kind, members, mentions = [], replyToMessageId, replyAuthorId, defaultBotIds = [], directedReplies = true, replyMentionUnion = true}) {
  const ids = new Set(mentions.map(value => typeof value === 'string' ? value : value.principalId))
  const hasBotMention = members.some(person => person.kind === 'bot' && ids.has(person.principalId))
  return members.flatMap(person => {
    if (person.kind !== 'bot' || person.retired || person.published === false || person.published === 0
      || kind !== 'dm' && !['active','passive'].includes(person.speakingMode)) return []
    const reason = kind === 'dm' ? 'Direct message' : ids.has(person.principalId) ? 'Mention'
      : (replyMentionUnion || !(directedReplies ? ids.size : hasBotMention)) && replyAuthorId === person.principalId ? 'Reply target'
      : !(directedReplies ? replyToMessageId : replyAuthorId) && !ids.size && defaultBotIds.includes(person.principalId) ? 'Default receiver' : null
    return reason ? [{...person, receivingReason:reason}] : []
  })
}
