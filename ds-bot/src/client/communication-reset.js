const PREFIX = 'ds-bot:communication:'
const EPOCH = 'ds-bot:federation-browser-epoch'
export function clearCommunicationBrowserState(epoch, session, local) {
  if (typeof epoch !== 'string' || !/^[0-9a-f-]{36}$/.test(epoch)) throw Object.assign(new Error('COMMUNICATION_BROWSER_RESET_REQUIRED'), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' })
  if (session.getItem(EPOCH) === epoch) return false
  for (const storage of [session, local]) {
    const keys = []
    for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key?.startsWith(PREFIX)) keys.push(key) }
    for (const key of keys) storage.removeItem(key)
    for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith(PREFIX)) throw Object.assign(new Error('COMMUNICATION_BROWSER_RESET_REQUIRED'), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' })
  }
  // Each tab has its own sessionStorage. A shared localStorage marker is not proof
  // that another tab's pending intents or in-memory composer were cleared.
  session.setItem(EPOCH, epoch)
  return true
}
