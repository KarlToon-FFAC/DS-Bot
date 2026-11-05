import { createElement as h, useEffect, useRef, useState } from 'react'
import { normalizeIpAddress } from '../shared/ip-address.js'
import { communicationFailure } from './communication-errors.js'
import { t } from './i18n.js'

export function AddressNotes({ contacts, notes = {}, onSave, busy }) {
  const [editing, setEditing] = useState(false), [address, setAddress] = useState(''), [note, setNote] = useState('')
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const locked = useRef(false), live = useRef(true), editor = useRef(null), opener = useRef(null), addButton = useRef(null)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    if (editing) editor.current?.focus()
    else if (opener.current) (opener.current.isConnected ? opener.current : addButton.current)?.focus()
  }, [editing])
  const addresses = [...new Set([...Object.keys(notes), ...contacts.map(person => normalizeIpAddress(person.ipAddress)).filter(Boolean)])].sort()
  const edit = (value, trigger) => { opener.current = trigger; setAddress(value); setNote(notes[value] ?? ''); setError(''); setEditing(true) }
  const save = async value => {
    if (locked.current || busy || !onSave) return
    locked.current = true; setSaving(true); setError('')
    try { await onSave(address, value); if (live.current) { setEditing(false); setNote('') } }
    catch (failure) { if (live.current) setError(communicationFailure(failure)) }
    finally { locked.current = false; if (live.current) setSaving(false) }
  }
  return h('section', { className: 'bt-comm-ip-notes', 'aria-label': t('IP notes') },
    h('h3', null, t('IP notes')),
    h('p', { className: 'bt-comm-reference' }, t('Saved only on this device for this Hub. IP notes label addresses, not people or trusted identities. Shared IPs use the same note.')),
    addresses.map(value => h('div', { key: value, className: 'bt-comm-ip-note-row' },
      h('span', null, h('code', null, value), notes[value] ? h('span', { className: 'bt-comm-ip-note' }, notes[value]) : null),
      h('button', { type: 'button', disabled: busy || saving || !onSave, 'aria-label': `${t('Edit IP note')} ${value}`, onClick: event => edit(value, event.currentTarget) }, t(notes[value] ? 'Edit note' : 'Add note')))),
    !editing ? h('button', { ref: addButton, type: 'button', disabled: busy || saving || !onSave, onClick: event => edit('', event.currentTarget) }, t('Add IP note')) :
      h('form', { className: 'bt-comm-ip-note-editor', onSubmit: event => { event.preventDefault(); void save(note) } },
        h('label', { className: 'bt-comm-field' }, t('IP address'), h('input', { ref: editor, value: address, maxLength: 128, disabled: saving, 'aria-label': t('IP address'), onChange: event => setAddress(event.target.value) })),
        h('label', { className: 'bt-comm-field' }, t('IP note'), h('input', { value: note, maxLength: 160, disabled: saving, 'aria-label': t('IP note'), onChange: event => setNote(event.target.value) })),
        h('div', null,
          h('button', { type: 'submit', disabled: busy || saving || !address.trim() }, t('Save note')),
          notes[normalizeIpAddress(address)] ? h('button', { type: 'button', disabled: busy || saving, onClick: () => { void save('') } }, t('Clear note')) : null,
          h('button', { type: 'button', disabled: saving, onClick: () => { setEditing(false); setError('') } }, t('Cancel')))),
    error ? h('p', { className: 'bt-comm-error', role: 'alert' }, error) : null)
}
