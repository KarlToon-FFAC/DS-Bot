import { mentionSpans } from '../shared/mentions.js'

export function contactLabels(contacts, instanceId, t = value => value) {
  const basic = contact => `${contact.displayName} · ${contact.instanceLabel ?? contact.homeInstanceId} · ${contact.kind === 'bot' ? 'Bot' : t('Human')} · ${t(contact.homeInstanceId === instanceId ? 'Local' : 'Remote')}`
  return new Map(contacts.map(contact => {
    const base = basic(contact)
    return [contact.principalId, contacts.filter(other => basic(other) === base).length > 1 ? `${base} · ${contact.principalId}` : base]
  }))
}

export function deliveryPhase(delivery) {
  if (delivery.revoked) return 'Revoked'
  if (delivery.aiAccepted) return 'Bot admitted'
  if (delivery.humanRead) return 'Read'
  if (delivery.uiApplied) return 'Displayed'
  if (delivery.targetStored) return 'Destination stored'
  return 'Waiting for destination'
}

// IP is a directory heading, never a recipient or authorization key. In particular,
// multiple paired devices behind one NAT keep their own principals and Humans.
export function contactsByAddress(contacts) {
  const groups=new Map(), seen=new Set()
  for(const contact of contacts){
    if(seen.has(contact.principalId))continue
    seen.add(contact.principalId)
    const address=contact.ipAddress||'Address unavailable'
    if(!groups.has(address))groups.set(address,new Map())
    const instances=groups.get(address)
    if(!instances.has(contact.homeInstanceId))instances.set(contact.homeInstanceId,{instanceId:contact.homeInstanceId,label:contact.instanceLabel??contact.homeInstanceId,contacts:[]})
    instances.get(contact.homeInstanceId).contacts.push(contact)
  }
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([address,instances])=>({address,instances:[...instances.values()].sort((a,b)=>a.instanceId.localeCompare(b.instanceId))}))
}

export function conversationTitle(member, humanId, labels) {
  return member.kind === 'group' ? member.title : member.info?.members.filter(person => person.principalId !== humanId).map(person => labels.get(person.principalId) ?? person.displayName).join(', ') || 'Private message'
}

// Stable principal identity also keeps avatars distinct behind shared addresses.
export function principalAvatar(principalId, displayName = '') {
  let hash = 0
  for (const char of String(principalId)) hash = (hash * 31 + char.codePointAt(0)) >>> 0
  return { initials: [...(displayName.trim() || '?')].slice(0, 2).join('').toUpperCase(), variant: hash % 4 }
}

export function mentionQuery(text, caret) {
  const before = text.slice(0, caret)
  if (/^\s*>/.test(before.split('\n').at(-1)) || (before.match(/```/g)?.length ?? 0) % 2 || (before.replace(/```[\s\S]*?```/g, '').match(/`/g)?.length ?? 0) % 2) return null
  const match = /(?:^|[\s(])@([^@\n]*)$/.exec(before)
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null
}

export function mentionChoices(members, query, allLabel = 'All Bots') {
  const needle = query.toLocaleLowerCase()
  return [
    ...(members.some(person => person.kind === 'bot') ? [{ principalId: '@all', displayName: allLabel, all: true }] : []),
    ...members,
  ].filter(person => (person.all ? `all ${person.displayName}` : person.displayName ?? '').toLocaleLowerCase().includes(needle))
}

export function insertMention(draft, range, person) {
  const name = person.all ? 'all' : person.displayName
  // Legacy Human names can equal a broadcast keyword. Their chip carries the
  // exact explicit target; ordinary text must not become a broadcast command.
  const manual = !person.all && mentionSpans('@' + name, []).some(span => span.start === 0 && span.all)
  const token = (manual ? '' : '@') + name + ' '
  const text = draft.text.slice(0, range.start) + token + draft.text.slice(range.end)
  return { text, mentions: person.all ? draft.mentions ?? [] : [...new Set([...(draft.mentions ?? []), person.principalId])],
    manualMentions: manual ? [...new Set([...(draft.manualMentions ?? []), person.principalId])] : draft.manualMentions ?? [], caret: range.start + token.length }
}

export function retainedMentions(text, selected, members, manualMentions = []) {
  const literalQuotes = text.replace(/^[\t ]*>[^\n]*/gm, line => ' '.repeat(line.length))
  const spans = mentionSpans(literalQuotes, members.map(person => ({ ...person, name: person.displayName })))
  return (selected ?? []).filter(id => {
    const person = members.find(member => member.principalId === id)
    return person && (manualMentions.includes(id) || spans.some(span => span.bot?.name.toLocaleLowerCase() === person.displayName.toLocaleLowerCase()))
  })
}

// Canonical history and an accepted outbox ACK can describe the same stop.
export function collaborationStops(events, outbox) {
  const stopped = new Map()
  for (const event of events) {
    if (event.type === 'message' && event.dispatchSuppressed === 'CAUSAL_LIMIT') stopped.set(event.message.messageId, event.causality)
  }
  for (const item of outbox) {
    if (item.state === 'accepted' && item.result?.dispatchSuppressed === 'CAUSAL_LIMIT' && !stopped.has(item.id)) stopped.set(item.id, item.result.causality)
  }
  return [...stopped].map(([messageId, causality]) => ({ messageId, causality }))
}
