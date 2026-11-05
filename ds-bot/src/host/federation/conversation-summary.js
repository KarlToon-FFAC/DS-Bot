const line = (value, limit) => {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/gu, ' ').trim()
  const chars = [...text]
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : text
}

export function conversationSummary(event, people) {
  if (event?.type !== 'message' || typeof event.message?.content?.text !== 'string') return null
  const { message } = event, principalId = message.author?.principalId
  if (typeof principalId !== 'string' || !['human', 'bot'].includes(message.author.kind)) return null
  const person = people.find(person => person.principalId === principalId)
  const time = event.serverAcceptedAt
  return { messageId: message.messageId, conversationSeq: event.conversationSeq, summary: line(message.content.text, 160),
    author: { principalId, kind: message.author.kind, displayName: line(person?.displayName ?? principalId, 80) },
    serverAcceptedAt: typeof time === 'string' && time.length <= 64 && Number.isFinite(Date.parse(time)) ? time : null }
}

export function safeManagementUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) return null
    return !url.username && !url.password && !url.search && !url.hash ? url.href : null
  } catch { return null }
}
