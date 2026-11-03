import { mentionSpans } from './mentions.js'

const fail = code => { throw Object.assign(new Error(code), { code }) }

export function communicationMentions(text, contacts, explicit = []) {
  if (!Array.isArray(explicit)) fail('UNKNOWN_MENTION')
  const selected = new Set(explicit.map(item => typeof item === 'string' ? item : item?.principalId))
  for (const id of selected) if (!contacts.some(contact => contact.principalId === id)) fail('UNKNOWN_MENTION')
  const literalQuotes = String(text).replace(/^[\t ]*>[^\n]*/gm, line => ' '.repeat(line.length))
  const candidates = contacts.map(contact => ({ ...contact, name: contact.displayName }))
  for (const span of mentionSpans(literalQuotes, candidates, { unknown: true })) {
    if (span.unknown) fail('UNKNOWN_MENTION')
    if (span.all) fail('UNSUPPORTED_CAPABILITY')
    const matches = candidates.filter(candidate => candidate.name.toLowerCase() === span.bot.name.toLowerCase())
    if (matches.length > 1) {
      if (!matches.some(candidate => selected.has(candidate.principalId))) fail('AMBIGUOUS_MENTION')
    } else selected.add(matches[0].principalId)
  }
  return [...selected].sort().map(principalId => ({ principalId }))
}
