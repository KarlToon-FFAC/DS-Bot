import { mentionSpans } from './mentions.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }

export function communicationMentions(text, contacts, explicit = [], { displayOnly = false } = {}) {
  if (!Array.isArray(explicit)) fail('UNKNOWN_MENTION')
  const selected = new Set(explicit.map(item => typeof item === 'string' ? item : item?.principalId))
  for (const id of selected) if (!contacts.some(contact => contact.principalId === id)) fail('UNKNOWN_MENTION')
  const literalQuotes = String(text).replace(/^[\t ]*>[^\n]*/gm, line => ' '.repeat(line.length))
  const candidates = contacts.map(contact => ({ ...contact, name: contact.displayName }))
  for (const span of mentionSpans(literalQuotes, candidates, { unknown: true, reservedAllFirst: true })) {
    if (span.unknown) { if (displayOnly) continue; fail('UNKNOWN_MENTION') }
    if (span.all) {
      for(const contact of contacts)if(contact.kind==='bot'||contact.principalId.startsWith('bot:'))selected.add(contact.principalId)
      continue
    }
    const matches = candidates.filter(candidate => candidate.name.toLowerCase() === span.bot.name.toLowerCase())
    if (matches.length > 1) {
      if (!matches.some(candidate => selected.has(candidate.principalId)) && !displayOnly) fail('AMBIGUOUS_MENTION')
    } else selected.add(matches[0].principalId)
  }
  return [...selected].sort().map(principalId => ({ principalId }))
}
