import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { useLiveRefresh } from './communication-live.js'
import { communicationFailure } from './communication-errors.js'

export function CommunicationMemory({ request, revision }) {
  const [value, setValue] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false), [liveError, setLiveError] = useState('')
  const generation = useRef(0), working = useRef(false)
  useEffect(() => () => { generation.current += 1 }, [request])
  useLiveRefresh(async () => {
    if (working.current) return
    const token = generation.current
    try {
      const result = await request({ endpoint: 'memory-settings' })
      if (token === generation.current) { setValue(result.localMemory); setLiveError('') }
    } catch (failure) { if (token === generation.current) throw failure }
  }, failure => setLiveError(communicationFailure(failure)), request, revision)
  const save = async next => {
    if (working.current) return
    working.current = true
    const token = ++generation.current
    setBusy(true); setError(''); setSaved(false)
    try {
      await request({ endpoint: 'set-memory-settings', localMemory: next })
      if (token === generation.current) { setValue(next); setSaved(true); setLiveError('') }
    } catch (failure) { if (token === generation.current) setError(communicationFailure(failure)) }
    finally { working.current = false; if (token === generation.current) setBusy(false) }
  }
  return h('section', null, h('h3', null, t('Local memory in remote conversations')),
    h('label', { className: 'bt-comm-check' }, h('input', { type: 'checkbox', checked: value === true, disabled: value === null || busy,
      onChange: event => { void save(event.target.checked) } }), t('Allow each Bot to use its own local memory')),
    h('p', null, t('Enabled by default for this Hub. Selected entries from each Bot’s own main memory are sent to its configured model service. Replies may share relevant facts with everyone in the conversation. Other chats, topic files and other Bots’ memory are not included.')),
    h('p', null, t('Turning this off stops new memory reads after configuration reload. It does not erase existing model context, saved session records or messages already shared. Existing conversations and recovery may still contain earlier facts.')),
    liveError ? h('p', { role: 'status' }, t('Status may be out of date.'), ' ', liveError) : null,
    saved ? h('p', { role: 'status' }, t('Saved. The configuration will reload.')) : null,
    error ? h('p', { role: 'alert' }, error) : null)
}
