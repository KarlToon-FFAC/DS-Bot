import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { communicationFailure } from './communication-errors.js'

export function CommunicationMemory({ request }) {
  const [value, setValue] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let active = true
    request({ endpoint: 'memory-settings' }).then(result => { if (active) setValue(result.localMemory) })
      .catch(failure => { if (active) setError(communicationFailure(failure)) })
    return () => { active = false }
  }, [request])
  const save = async next => {
    setBusy(true); setError(''); setSaved(false)
    try {
      await request({ endpoint: 'set-memory-settings', localMemory: next })
      setValue(next); setSaved(true)
    } catch (failure) { setError(communicationFailure(failure)) }
    finally { setBusy(false) }
  }
  return h('section', null, h('h3', null, t('Local memory in remote conversations')),
    h('label', { className: 'bt-comm-check' }, h('input', { type: 'checkbox', checked: value === true, disabled: value === null || busy,
      onChange: event => { void save(event.target.checked) } }), t('Allow each Bot to use its own local memory')),
    h('p', null, t('Enabled by default for this Hub. Selected entries from each Bot’s own main memory are sent to its configured model service. Replies may share relevant facts with everyone in the conversation. Other chats, topic files and other Bots’ memory are not included.')),
    h('p', null, t('Turning this off stops new memory reads after configuration reload. It does not erase existing model context, saved session records or messages already shared. Existing conversations and recovery may still contain earlier facts.')),
    saved ? h('p', { role: 'status' }, t('Saved. The configuration will reload.')) : null,
    error ? h('p', { role: 'alert' }, error) : null)
}
