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

export function conversationTitle(member, humanId, labels) {
  return member.kind === 'group' ? member.title : member.info?.members.filter(person => person.principalId !== humanId).map(person => labels.get(person.principalId) ?? person.displayName).join(', ') || 'Private message'
}
