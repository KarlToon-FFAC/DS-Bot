import { createElement as h, useRef, useState } from 'react'
import { CommunicationDialog } from './communication-dialog.js'
import { communicationFailure } from './communication-errors.js'
import { t } from './i18n.js'

export function CommunicationWorkApprovals({ state, request, refresh }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const flight = useRef(false)
  const approvals = state.workApprovals ?? []
  const entry = approvals.find(item => item.id === selected) ?? approvals[0]
  const answer = async (id, choice) => {
    if (flight.current) return
    flight.current = true
    setBusy(true); setError('')
    try {
      await request({ endpoint: 'answer-work-approval', id, choice, expectedScope: state.conversationPreferencesScope })
      await refresh()
    } catch (failure) { setError(communicationFailure(failure)) }
    finally { flight.current = false; setBusy(false) }
  }
  return h('div', null,
    approvals.length ? h('button', { type: 'button', onClick: () => { setError(''); setOpen(true) }, 'aria-label': t('Review local work approvals') }, t('Review local work approvals'), ' · ', approvals.length) : null,
    h(CommunicationDialog, { open, title: 'Local work approvals', onClose: () => setOpen(false), busy, error,
      actions: h('div', { className: 'bt-comm-operation-buttons' },
        h('button', { type: 'button', disabled: busy, onClick: () => setOpen(false) }, t('Close')),
        entry ? h('button', { type: 'button', disabled: busy || !entry.answerable, onClick: () => { void answer(entry.id, 'reject') } }, t('Reject')) : null,
        entry ? h('button', { type: 'button', disabled: busy || !entry.answerable, onClick: () => { void answer(entry.id, 'allow') } }, t('Allow once')) : null) },
      h('p', { className: 'bt-comm-reference' }, t('These requests execute on this device using your Bot’s permissions. Only you can approve; remote participants cannot.')),
      approvals.length > 1 ? h('label', { className: 'bt-comm-field' }, t('Work approval request'),
        h('select', { value: entry.id, disabled: busy, 'aria-label': t('Work approval request'), onChange: event => { setSelected(event.target.value); setError('') } },
          approvals.map(item => h('option', { key: item.id, value: item.id }, `${item.botName} · ${item.tool} · ${item.conversationTitle ?? item.conversationId}`)))) : null,
      entry ? h('section', { key: entry.id },
        h('h3', null, entry.botName, ' · ', entry.tool),
        h('p', { className: 'bt-comm-reference' }, entry.conversationTitle ?? entry.conversationId),
        entry.sourceAuthorName ? h('p', { className: 'bt-comm-reference' }, t('Requested by'), ': ', entry.sourceAuthorName) : null,
        entry.detail?.workDirectory ? h('p', { className: 'bt-comm-reference' }, t('Working folder'), ': ', entry.detail.workDirectory) : null,
        entry.detail?.text ? h('p', null, entry.detail.text) : null,
        entry.detail?.code ? h('pre', { className: 'bt-comm-pending-text' }, entry.detail.code) : null,
        entry.reason ? h('p', null, entry.reason) : null) : h('p', null, t('No local work approvals are pending.'))))
}
