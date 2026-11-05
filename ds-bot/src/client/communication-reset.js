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

let reloadPending = false
// Captured once per document, so only a genuinely fresh document may finalize the
// second cleanup. An old concurrent request cannot turn a reload fence back off.
let hydrationBlocked = false
const documentEpoch = (() => {
  if (typeof sessionStorage === 'undefined') return null
  let value
  try {
    value = sessionStorage.getItem(EPOCH)
    if (value?.startsWith('pending:')) clearCommunicationBrowserState(value.slice(8), sessionStorage, localStorage)
  } catch { hydrationBlocked = true }
  return value
})()
export function readCommunicationBrowserState(storage, key) {
  if (reloadPending || hydrationBlocked) return null
  return storage.getItem(key)
}
export const communicationBrowserResetPending = () => reloadPending
export function saveCommunicationBrowserState(storage, key, value) {
  if (reloadPending || hydrationBlocked) return false
  storage.setItem(key, JSON.stringify(value))
  return true
}
export function prepareCommunicationBrowserEpoch(epoch, session, local) {
  if (reloadPending) return true
  const resumed = documentEpoch === `pending:${epoch}`
  const changed = clearCommunicationBrowserState(epoch, session, local)
  hydrationBlocked = false
  if (changed && !resumed) {
    reloadPending = true
    // Late attachment reads/callbacks in this document cannot persist after the
    // fence. The next document clears once more before confirming the epoch.
    session.setItem(EPOCH, `pending:${epoch}`)
    return true
  }
  return false
}
