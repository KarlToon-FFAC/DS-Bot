import { mentionSpans } from './mentions.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }

export function communicationMentions(text, contacts, explicit = [], { displayOnly = false, retired = [] } = {}) {
  if (!Array.isArray(explicit)) fail('UNKNOWN_MENTION')
  const retiredPeople = [...contacts.filter(person => person.retired), ...retired]
  const retiredIds = new Set(retiredPeople.map(person => person.principalId))
  contacts = contacts.filter(person => !retiredIds.has(person.principalId))
  const selected = new Set(explicit.map(item => typeof item === 'string' ? item : item?.principalId))
  for (const id of selected) {
    if (retiredIds.has(id)) fail('BOT_RETIRED')
    if (!contacts.some(contact => contact.principalId === id)) fail('UNKNOWN_MENTION')
  }
  const literalQuotes = String(text).replace(/^[\t ]*>[^\n]*/gm, line => ' '.repeat(line.length))
  const former = displayOnly ? [] : retiredPeople.filter(person => !contacts.some(active => active.displayName?.toLowerCase() === person.displayName?.toLowerCase()))
  const candidates = [...contacts, ...former.map(person => ({ ...person, retired: true }))].map(contact => ({ ...contact, name: contact.displayName }))
  for (const span of mentionSpans(literalQuotes, candidates, { unknown: true, reservedAllFirst: true })) {
    if (span.unknown) {
      // An unknown @ embedded in prose, such as 收到@你的消息, is literal text.
      // Explicit recipient tokens and stale picker IDs still fail validation.
      if (displayOnly || span.start > 0 && /[\p{L}\p{N}]/u.test(literalQuotes[span.start - 1])) continue
      fail('UNKNOWN_MENTION')
    }
    if (span.all) {
      for(const contact of contacts)if(contact.kind==='bot'||contact.principalId.startsWith('bot:'))selected.add(contact.principalId)
      continue
    }
    if (span.bot.retired) fail('BOT_RETIRED')
    const matches = candidates.filter(candidate => candidate.name.toLowerCase() === span.bot.name.toLowerCase())
    if (matches.length > 1) {
      if (!matches.some(candidate => selected.has(candidate.principalId)) && !displayOnly) fail('AMBIGUOUS_MENTION')
    } else selected.add(matches[0].principalId)
  }
  return [...selected].sort().map(principalId => ({ principalId }))
}
