import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { CommunicationAvatar } from './communication-profile.js'
import { BotMark } from './mark.js'
import { t } from './i18n.js'

const statuses = new Set(['prepared', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'accepted'])
const statusLabel = value => t(statuses.has(value) ? value : 'Status unavailable')
const failureLabel = () => t('The action could not be confirmed. Refresh status before trying again.')
export function hubManagementAddress(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) return null
    return url.href
  } catch { return null }
}
const adminLink = url => hubManagementAddress(url) ? h('a', { href: hubManagementAddress(url), target: '_blank', rel: 'noopener noreferrer', className: 'bt-comm-admin-link' }, t('Open Hub management'), ' · ', new URL(url).origin) : null

export function AddDevice({ request, manualGuide, displayName = 'Human' }) {
  const [code, setCode] = useState(''), [name, setName] = useState(displayName), [hub, setHub] = useState(null)
  const [storage, setStorage] = useState(null), [enrollments, setEnrollments] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    let active = true
    void request({ endpoint: 'onboarding-storage' }).then(value => {
      if (!active) return
      setStorage(value.storage ?? value.enrollments?.[0]?.storage ?? null)
      setEnrollments(value.enrollments ?? (value.hubId ? [value] : []))
    }).catch(() => { if (active) setError(t('Unable to read pairing status')) })
    return () => { active = false; generation.current += 1 }
  }, [request])
  const run = async work => {
    if (busy) return
    const token = generation.current
    setBusy(true); setError('')
    try { await work(token) } catch { if (token === generation.current) setError(failureLabel()) }
    finally { if (token === generation.current) setBusy(false) }
  }
  const update = value => setEnrollments(current => [...current.filter(item => item.hubId !== value.hubId), value])
  return h('div', { className: 'bt-comm-onboarding' },
    h('p', null, t('Paste a Hub code from its owner. Review the actual address before requesting access. Devices are not discovered automatically.')),
    h('label', { className: 'bt-comm-field' }, t('Hub code'), h('textarea', { value: code, rows: 2, maxLength: 4096, 'aria-label': t('Hub code'), onChange: event => { generation.current += 1; setBusy(false); setCode(event.target.value); setHub(null); setError('') } })),
    h('button', { type: 'button', disabled: busy || !code.trim(), onClick: () => { void run(async token => { const value = await request({ endpoint: 'decode-hub-code', hubCode: code }); if (token === generation.current) setHub(value) }) } }, t('Review Hub')),
    hub ? h('section', { className: 'bt-comm-set-card' }, h('h3', null, t('Confirm the Hub')), h('p', null, t('Hub address'), ': ', h('code', null, hub.url)), h('p', null, 'Hub ID: ', h('code', null, hub.hubId)),
      h('label', { className: 'bt-comm-field' }, t('Device display name'), h('input', { value: name, maxLength: 100, 'aria-label': t('Device display name'), onChange: event => setName(event.target.value) })),
      h('button', { type: 'button', disabled: busy || !name.trim() || !storage, onClick: () => { void run(async token => {
        const value = await request({ endpoint: 'join-hub', hubCode: code, displayName: name, confirmedHubId: hub.hubId, confirmedUrl: hub.url })
        if (token === generation.current) update(value)
      }) } }, t('Confirm and request access'))) : null,
    h('p', { className: 'bt-comm-storage-note' }, t('Pairing keys are created only when you confirm a request. The default local credential store is plaintext protected by your OS account permissions, not encryption or isolation from tools running as the same user.')),
    storage ? h('p', { className: 'bt-comm-reference' }, t('Credential storage'), ': ', storage.defaultProvider, ' · ', t(storage.encryptedByDefault ? 'Encrypted by provider' : 'Not encrypted by default')) : null,
    enrollments.map(item => h('section', { key: item.hubId, className: 'bt-comm-address' }, h('p', null, h('code', null, item.hubId), ' · ', statusLabel(item.status)), h('p', { className: 'bt-comm-reference' }, item.url),
      item.status === 'approved' ? h('p', { role: 'status' }, t('Approved. The device configuration is saved through the app and will reload. Existing settings are preserved.')) : null,
      h('button', { type: 'button', disabled: busy, onClick: () => { void run(async token => { const value = await request({ endpoint: 'hub-join-status', hubId: item.hubId }); if (token === generation.current) update(value) }) } }, t('Check approval')),
      ['prepared', 'pending'].includes(item.status) ? h('button', { type: 'button', disabled: busy, onClick: () => { void run(async token => { const value = await request({ endpoint: 'cancel-hub-join', hubId: item.hubId }); if (token === generation.current) update(value) }) } }, t('Cancel request')) : null)),
    h('details', { className: 'bt-comm-manual-guide' }, h('summary', null, t('Manual configuration guide')), manualGuide),
    error ? h('p', { className: 'bt-comm-error', role: 'alert' }, error) : null)
}

function BotChoices({ bots, selected, onChange, label }) {
  return h('fieldset', { className: 'bt-comm-bot-choices' }, h('legend', null, t(label)), bots.length ? bots.map(bot => h('label', { key: bot.id, className: 'bt-comm-check' },
    h('input', { type: 'checkbox', checked: selected.includes(bot.id), onChange: event => onChange(event.target.checked ? [...selected, bot.id] : selected.filter(id => id !== bot.id)), 'data-local-bot-id': bot.id }),
    h(BotMark, { bot, size: 24 }), bot.name, h('span', { className: 'bt-comm-reference' }, bot.id))) : h('p', { className: 'bt-comm-reference' }, t('No published Bots')))
}

export function ContactManager({ request, operation, contacts, managementUrl }) {
  const [data, setData] = useState(null), [code, setCode] = useState(''), [userCode, setUserCode] = useState('')
  const [published, setPublished] = useState([]), [share, setShare] = useState([]), [incomingShares, setIncomingShares] = useState({})
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState('')
  const generation = useRef(0)
  const load = async () => {
    const token = generation.current
    const [ownCode, requests, relations, available] = await Promise.all([
      request({ endpoint: 'user-code' }), request({ endpoint: 'contact-requests' }), request({ endpoint: 'contact-relations' }), request({ endpoint: 'available-bots' }),
    ])
    if (token !== generation.current) return
    setCode(ownCode.userCode); setData({ requests, relations, available }); setPublished(available.publishedBotIds ?? [])
  }
  useEffect(() => { void load().catch(() => setError(failureLabel())); return () => { generation.current += 1 } }, [request])
  const run = async work => {
    if (busy) return
    const token = generation.current
    setBusy(true); setError('')
    try { await work(); if (token === generation.current) await load() }
    catch { if (token === generation.current) setError(failureLabel()) }
    finally { if (token === generation.current) setBusy(false) }
  }
  const available = data?.available ?? { bots: [], publishedBotIds: [] }
  const sharedBots = available.bots.filter(bot => available.publishedBotIds.includes(bot.id))
  const labelFor = id => contacts.find(person => person.principalId === id)?.displayName ?? id
  return h('div', { className: 'bt-comm-contact-manager' },
    adminLink(managementUrl),
    h('h3', null, t('Your user code')), h('p', { className: 'bt-comm-user-code', tabIndex: 0 }, code || t('Loading…')),
    h('p', { className: 'bt-comm-reference' }, t('Share this code with the person you want to add. Both people choose which local Bots to share; none are selected by default.')),
    h('button', { type: 'button', disabled: busy || !code, onClick: () => { if (confirm !== 'rotate') setConfirm('rotate'); else { setConfirm(''); void run(() => operation('rotate-user-code', {})) } } }, t(confirm === 'rotate' ? 'Confirm code rotation' : 'Rotate user code')),
    h('label', { className: 'bt-comm-field' }, t('Other user code'), h('input', { value: userCode, maxLength: 64, 'aria-label': t('Other user code'), onChange: event => setUserCode(event.target.value) })),
    h(BotChoices, { bots: sharedBots, selected: share, onChange: setShare, label: 'Bots to share with this request' }),
    h('button', { type: 'button', disabled: busy || !userCode.trim(), onClick: () => { void run(async () => { await operation('request-contact', { userCode, localBotIds: share }); setUserCode(''); setShare([]) }) } }, t('Request contact')),
    h('h3', null, t('Contact requests')),
    (data?.requests ?? []).map(item => h('section', { key: item.requestId, className: 'bt-comm-address' },
      h('p', { title: item.senderPrincipalId ?? item.requestId }, item.senderPrincipalId ? h(CommunicationAvatar, { person: contacts.find(person => person.principalId === item.senderPrincipalId) ?? { principalId: item.senderPrincipalId, displayName: item.senderName, kind: 'human' }, request, allowed: contacts.some(person => person.principalId === item.senderPrincipalId) }) : null, item.senderName ?? t('Outgoing request'), ' · ', statusLabel(item.status)),
      item.status === 'pending' && item.direction === 'incoming' ? h(Fragment, null,
        h(BotChoices, { bots: sharedBots, selected: incomingShares[item.requestId] ?? [], label: 'Bots to share when accepting', onChange: ids => setIncomingShares(current => ({ ...current, [item.requestId]: ids })) }),
        h('button', { type: 'button', disabled: busy, onClick: () => { void run(() => operation('accept-contact', { requestId: item.requestId, expectedVersion: item.version, localBotIds: incomingShares[item.requestId] ?? [] })) } }, t('Accept contact')),
        h('button', { type: 'button', disabled: busy, onClick: () => { void run(() => operation('reject-contact', { requestId: item.requestId, expectedVersion: item.version })) } }, t('Reject contact'))) :
        item.status === 'pending' ? h('button', { type: 'button', disabled: busy, onClick: () => { void run(() => operation('cancel-contact', { requestId: item.requestId, expectedVersion: item.version })) } }, t('Cancel request')) : null)),
    h('h3', null, t('Connected contacts')),
    (data?.relations ?? []).filter(item => item.active).map(item => h('section', { key: item.otherHumanPrincipalId, className: 'bt-comm-address' }, h('p', { title: item.otherHumanPrincipalId }, h(CommunicationAvatar, { person: contacts.find(person => person.principalId === item.otherHumanPrincipalId) ?? { principalId: item.otherHumanPrincipalId, displayName: labelFor(item.otherHumanPrincipalId), kind: 'human' }, request, allowed: contacts.some(person => person.principalId === item.otherHumanPrincipalId) }), labelFor(item.otherHumanPrincipalId)),
      h('p', { className: 'bt-comm-reference' }, t('Shared Bots'), ': ', item.botPrincipalIds.map(labelFor).join(', ') || t('None')),
      h('button', { type: 'button', disabled: busy, onClick: () => { const id = item.otherHumanPrincipalId; if (confirm !== id) setConfirm(id); else { setConfirm(''); void run(() => operation('revoke-contact', { otherHumanPrincipalId: id, expectedVersion: item.version })) } } }, t(confirm === item.otherHumanPrincipalId ? 'Confirm contact removal' : 'Remove contact')))),
    h('details', null, h('summary', null, t('Published Bots')), h(BotChoices, { bots: available.bots, selected: published, onChange: setPublished, label: 'Bots available to contacts' }),
      h('button', { type: 'button', disabled: busy || JSON.stringify([...published].sort()) === JSON.stringify([...available.publishedBotIds].sort()), 'data-dirty': JSON.stringify([...published].sort()) !== JSON.stringify([...available.publishedBotIds].sort()), onClick: () => { void run(() => operation('publish-bots', { localBotIds: published })) } }, t('Save published Bots'))),
    h('button', { type: 'button', disabled: busy, onClick: () => { void run(async () => {}) } }, t('Refresh contacts')),
    error ? h('p', { className: 'bt-comm-error', role: 'alert' }, error) : null)
}
