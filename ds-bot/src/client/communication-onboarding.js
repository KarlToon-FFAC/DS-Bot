import { CommunicationDialog, CommunicationActionDialog } from './communication-dialog.js'
import { BotPublicProfile } from './bot-settings.js'
import { call } from './api.js'
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { CommunicationAvatar } from './communication-profile.js'
import { ContactDirectory } from './communication-contacts.js'
import { AddressNotes } from './communication-address-notes.js'
import { BotMark } from './mark.js'
import { t } from './i18n.js'
import { communicationFailure, knownCommunicationFailure } from './communication-errors.js'
import { useLiveRefresh } from './communication-live.js'

const statuses = new Set(['prepared', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'accepted'])
const statusLabel = value => t(statuses.has(value) ? value : 'Status unavailable')
const failureLabel = error => t(communicationFailure(error ?? {}))
const enrollmentErrors = {
  HUB_TLS_UNTRUSTED: 'The Hub certificate authority is not trusted. Obtain a fresh signed Hub code through a trusted channel and explicitly update this Hub CA trust. Keep TLS verification enabled.',
  HUB_TLS_HOSTNAME_MISMATCH: 'The Hub address does not match the certificate. Ask its administrator for a certificate covering this exact reachable hostname or IP.',
  HUB_TLS_CERT_EXPIRED: 'The Hub certificate has expired. Ask its administrator to renew it.',
  HUB_TLS_CERT_TIME_INVALID: 'The Hub certificate is not valid yet. Check both clocks and the certificate dates.',
  HUB_CONNECTION_REFUSED: 'The Hub refused the connection. Check its listening address and existing network routing with the administrator.',
  HUB_CONNECTION_TIMEOUT: 'The Hub connection timed out. Local code review does not establish reachability; check the actual address and network route.',
  HUB_UNREACHABLE: 'Cannot establish the Hub connection. Check its reachable WSS address and trusted certificate.',
  TLS_REQUIRED: 'The Hub requires a trusted WSS connection.',
  HUB_ADDRESS_FORBIDDEN: 'The Hub address is not allowed. Ask its owner for a reachable trusted WSS address.',
  MANAGEMENT_DISABLED: 'Hub enrollment is disabled. Ask its administrator to enable management.',
  JOIN_NOT_FOUND: 'The Hub has no saved request with this ID. You may explicitly request access again using the saved device identity.',
  JOIN_NOT_SUBMITTED: 'No request has been submitted. Fix the reported local or connection problem before requesting access.',
  CREDENTIAL_STORAGE_UNAVAILABLE: 'The local credential service is unavailable. Check the app version and credential provider.',
  CREDENTIAL_STORAGE_READ_ONLY: 'The local credential store is read only. No new enrollment can be saved.',
  COMMUNICATION_CREDENTIAL_MISMATCH: 'The saved enrollment belongs to another identity or Hub. Preserve it and check the configured profile.',
  COMMUNICATION_PAIRING_CONFLICT: 'This profile is already bound to another Hub or instance. Use the intended separate profile.',
  HUB_CONFIRMATION_REQUIRED: 'Review and confirm the exact Hub address again.',
  INVALID_ENROLLMENT_CHALLENGE: 'The Hub returned an invalid or different enrollment identity. Do not retry until the Hub is checked.',
  CONFIG_EDIT_OVERLAID: 'Enrollment approval is saved, but a home or command-line overlay blocks configuration changes.',
  CONFIG_EDITOR_UNAVAILABLE: 'The app configuration editor is unavailable. Update the app before applying approved enrollment.',
  CONNECTION_LOST: 'The enrollment result is uncertain. Check the saved request and its approval before requesting access again.',
  REQUEST_TIMEOUT: 'The enrollment request timed out. Check the saved request and its approval before requesting access again.',
}
const enrollmentPhases = {
  ENROLLMENT_CONNECT_FAILED: 'The connection failed before the enrollment exchange completed.',
  ENROLLMENT_CHALLENGE_FAILED: 'The Hub challenge could not be confirmed. Check the saved request before retrying.',
  ENROLLMENT_PROOF_FAILED: 'The enrollment result is uncertain. Check the saved request and its approval before requesting access again.',
  COMMUNICATION_CREDENTIAL_READ_FAILED: 'The saved local enrollment could not be read.',
  COMMUNICATION_CREDENTIAL_WRITE_FAILED: 'The local enrollment could not be saved. Preserve existing data and check the credential provider.',
  COMMUNICATION_CREDENTIAL_DESCRIBE_FAILED: 'The local credential provider status is unavailable.',
  COMMUNICATION_CREDENTIAL_LIST_FAILED: 'Saved local enrollments could not be listed.',
  COMMUNICATION_CONFIG_WRITE_FAILED: 'Enrollment approval may be saved, but app configuration could not be updated. Check approval before retrying.',
}
export function enrollmentFailure(error) {
  const code = typeof error?.code === 'string' && Object.hasOwn(enrollmentErrors, error.code) ? error.code : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'REQUEST_TIMEOUT' : null
  const phase = typeof error?.phase === 'string' && Object.hasOwn(enrollmentPhases, error.phase) ? error.phase : null
  const shared = communicationFailure(error)
  const message = code ? enrollmentErrors[code] : knownCommunicationFailure(error) ? shared : phase ? enrollmentPhases[phase] : shared
  return t(message) + (code || phase ? ` [${[code, phase].filter(Boolean).join(' · ')}]` : '')
}
export function hubManagementAddress(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) return null
    return url.href
  } catch { return null }
}

export function AddDevice({ request, displayName = 'Human', revision }) {
  const [code, setCode] = useState(''), [name, setName] = useState(displayName), [hub, setHub] = useState(null)
  const [storage, setStorage] = useState(null), [enrollments, setEnrollments] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [absentHub, setAbsentHub] = useState(null)
  const [uncertainHub, setUncertainHub] = useState(null)
  const [selectedHub,setSelectedHub] = useState(null),[resumeConfirmed,setResumeConfirmed]=useState({})
  const [lifecycle,setLifecycle]=useState(null),[deleteHistory,setDeleteHistory]=useState(false)
  const [liveError, setLiveError] = useState('')
  const generation = useRef(0), loadOrder = useRef(0), working = useRef(false)
  useEffect(() => () => { generation.current += 1; loadOrder.current += 1 }, [request])
  useLiveRefresh(async () => {
    if (working.current) return
    const token = generation.current
    const saved = await refreshStorage(token).catch(failure => { if (token === generation.current) throw failure; return null })
    if (!saved || token !== generation.current || working.current) return
    // Reconcile only saved identities. These checks never submit a join, resume
    // retained work, rotate trust or replace credentials after an uncertain result.
    const checks = saved.enrollments.filter(item => item.requestId && (['prepared', 'pending'].includes(item.status) || item.status === 'approved' && saved.selectedHub?.enabled !== true) && !item.paused && !item.departed && (!saved.selectedHub?.hubId || saved.selectedHub.hubId === item.hubId))
    let failure
    for (const item of checks) {
      if (token !== generation.current || working.current) return
      try {
        const value = await request({ endpoint: 'hub-join-status', hubId: item.hubId })
        if (token === generation.current && !working.current) { update(value); setAbsentHub(current => current === item.hubId ? null : current) }
      } catch (error) {
        if (token === generation.current && error.code === 'JOIN_NOT_FOUND') setAbsentHub(item.hubId)
        failure ??= error
      }
    }
    for (const item of saved.enrollments.filter(item => item.status === 'approved' && item.instanceId)) {
      if (token !== generation.current || working.current) return
      try { await request({ endpoint: 'hub-leave-status', hubId: item.hubId, confirmedUrl: item.url }) }
      catch (error) { failure ??= error }
    }
    if (checks.length || saved.enrollments.some(item => item.status === 'approved' && item.instanceId)) await refreshStorage(token).catch(error => { if (token === generation.current) throw error })
    if (failure && token === generation.current && !working.current) throw failure
    if (token === generation.current) setLiveError('')
  }, failure => setLiveError(enrollmentFailure(failure)), request, revision)
  const run = async work => {
    if (working.current) return
    working.current = true; loadOrder.current += 1
    const token = ++generation.current
    setBusy(true); setError(''); setLiveError('')
    try { await work(token) } catch (failure) {
      if (token === generation.current) {
        setError(enrollmentFailure(failure))
        // This reads local status only. Never automatically resend a proof or
        // generate a replacement identity after an uncertain result.
        try { await refreshStorage(token) } catch { /* Preserve the original safe diagnostic. */ }
      }
    }
    finally { working.current = false; if (token === generation.current) setBusy(false) }
  }
  const update = value => setEnrollments(current => [...current.filter(item => item.hubId !== value.hubId), value])
  const refreshStorage = async token => {
    const order = ++loadOrder.current
    const value = await request({ endpoint: 'onboarding-storage' })
    if (token !== generation.current || order !== loadOrder.current) return
    setStorage(value.storage ?? storage)
    const selected = value.selectedHub ?? (value.configured && value.hubId ? {hubId:value.hubId,url:value.url} : null)
    setSelectedHub(selected)
    if (hub) setUncertainHub(current => current === hub.hubId ? null : current)
    if (value.enrollments) setEnrollments(value.enrollments)
    else if (value.hubId) update(value)
    return { selectedHub: selected, enrollments: value.enrollments ?? (value.hubId ? [value] : []) }
  }
  const existingRequest = hub && enrollments.some(item => item.hubId === hub.hubId && item.requestId && ['prepared', 'pending', 'approved'].includes(item.status)) && absentHub !== hub.hubId
  const differentHub=Boolean(hub&&selectedHub?.url&&(selectedHub.hubId!==hub.hubId||selectedHub.url!==hub.url))
  const select = async (value,token,hubCode) => {
    await request({endpoint:'switch-hub',...(hubCode?{hubCode,displayName:name}:{hubId:value.hubId}),...(selectedHub?.hubId?{expectedCurrentHubId:selectedHub.hubId}:{}),
      confirmedHubId:value.hubId,confirmedUrl:value.url,...(value.trustFingerprint?{confirmedTrustFingerprint:value.trustFingerprint}:{})})
    if(token===generation.current){setResumeConfirmed({});await refreshStorage(token)}
  }
  return h('div', { className: 'bt-comm-onboarding' },
    h('p', null, t('Paste a Hub code from its owner. Review the actual address before requesting access. Devices are not discovered automatically.')),
    h('p', { className: 'bt-comm-reference' }, t('Review only decodes the Hub code locally. It does not test network access or submit a request.')),
    h('label', { className: 'bt-comm-field' }, t('Hub code'), h('textarea', { value: code, rows: 2, maxLength: 65536, 'aria-label': t('Hub code'), onChange: event => { generation.current += 1; loadOrder.current += 1; setBusy(false); setCode(event.target.value); setHub(null); setError('') } })),
    h('button', { type: 'button', disabled: busy || !code.trim(), onClick: () => { void run(async token => { const value = await request({ endpoint: 'decode-hub-code', hubCode: code }); if (value.version !== 2 || !value.trustFingerprint) throw Object.assign(new Error('HUB_V2_MIGRATION_REQUIRED'), {code:'HUB_V2_MIGRATION_REQUIRED'}); if (token === generation.current) setHub(value) }) } }, t('Review Hub')),
    hub ? h('section', { className: 'bt-comm-set-card' }, h('h3', null, t('Confirm the Hub')), h('p', null, t('Hub address'), ': ', h('code', null, hub.url)), h('p', null, 'Hub ID: ', h('code', null, hub.hubId)),
      h('p', { className: 'bt-comm-reference' }, t('Accept this code only from a trusted channel. Its own certificate cannot authenticate an untrusted source.')),
      h('p', null, t('Hub CA fingerprint'), ': ', h('code', null, hub.trustFingerprint)),
      h('label', { className: 'bt-comm-field' }, t('Device display name'), h('input', { value: name, maxLength: 100, 'aria-label': t('Device display name'), onChange: event => setName(event.target.value) })),
      differentHub?h('p',{className:'bt-comm-reference'},t('Switching pauses the current Hub and retains its data. A new Hub starts with a separate identity and no published Bots.')):null,
      differentHub&&selectedHub?.legacy?h('p',{role:'status'},t('Legacy shared-secret pairing cannot be safely assigned to another Hub. Keep this data and enroll through a separate profile first.')):null,
      differentHub?h('button',{type:'button',disabled:busy||!name.trim()||selectedHub?.legacy,onClick:()=>{void run(token=>select(hub,token,code))}},t('Select this Hub')):null,
      h('button', { type: 'button', disabled: busy || differentHub || !name.trim() || !storage || existingRequest || uncertainHub === hub.hubId, onClick: () => { void run(async token => {
        setAbsentHub(null)
        setUncertainHub(hub.hubId)
        const value = await request({ endpoint: 'join-hub', hubCode: code, displayName: name, confirmedHubId: hub.hubId, confirmedUrl: hub.url, ...(hub.trustFingerprint ? { confirmedTrustFingerprint: hub.trustFingerprint } : {}) })
        if (token === generation.current) { update(value); setUncertainHub(null) }
      }) } }, t('Confirm and request access')),
      hub.trustFingerprint && enrollments.some(item => item.hubId === hub.hubId && item.url === hub.url) ? h('button', { type: 'button', disabled: busy, onClick: () => { void run(async token => {
        const value = await request({ endpoint: 'update-hub-trust', hubCode: code, confirmedHubId: hub.hubId, confirmedUrl: hub.url, confirmedTrustFingerprint: hub.trustFingerprint })
        if (token === generation.current) update(value)
      }) } }, t('Update this Hub CA trust')) : null) : null,
    h('p', { className: 'bt-comm-storage-note' }, t('Confirming a new Hub selection or join creates its own device key. Disconnecting retains that key and Hub data; it does not revoke membership on the server. The default credential store is plaintext protected by your OS account permissions, not encrypted against the same user.')),
    storage ? h('p', { className: 'bt-comm-reference' }, t('Credential storage'), ': ', storage.defaultProvider, ' · ', t(storage.encryptedByDefault ? 'Encrypted by provider' : 'Not encrypted by default')) : null,
    selectedHub?.legacy?h('section',{className:'bt-comm-address'},h('h3',null,t('Current Hub')),h('code',null,selectedHub.url),
      h('p',{className:'bt-comm-reference'},t('Local disconnect preserves server membership and queued work.')),
      selectedHub.enabled?h('button',{type:'button',disabled:busy,onClick:()=>{void run(async token=>{await request({endpoint:'disconnect-hub',confirmedUrl:selectedHub.url,...(selectedHub.hubId?{hubId:selectedHub.hubId}:{})});await refreshStorage(token)})}},t('Disconnect this Hub')):h(Fragment,null,
        h('label',{className:'bt-comm-check'},h('input',{type:'checkbox',checked:Boolean(resumeConfirmed.legacy),onChange:event=>setResumeConfirmed({legacy:event.target.checked})}),t('Resume retained pending messages and work after the Hub checks authorization.')),
        h('button',{type:'button',disabled:busy||!resumeConfirmed.legacy,onClick:()=>{void run(async token=>{await request({endpoint:'resume-hub',confirmedUrl:selectedHub.url,confirmResume:true,...(selectedHub.hubId?{hubId:selectedHub.hubId}:{})});setResumeConfirmed({});await refreshStorage(token)})}},t('Resume this Hub')))):null,
    enrollments.map(item => h('section', { key: item.hubId, className: 'bt-comm-address' }, h('p', null, h('code', null, item.hubId), ' · ', statusLabel(item.status)), h('p', { className: 'bt-comm-reference' }, item.url),
      item.requestId ? h('p', { className: 'bt-comm-reference' }, t('Request ID'), ': ', h('code', null, item.requestId)) : null,
      item.departed?h('p',{role:'status'},t('Access revoked. History is retained; this device cannot resume.')):item.paused?h('p',{role:'status'},t('Paused. Identity, trust and Hub history are retained separately.')):item.status === 'approved' ? h('p', { role: 'status' }, t('Saved approval. This is not a live connection check. The device configuration is saved through the app; current connection status is shown separately.')) : null,
      item.status==='approved'&&!item.departed?h('button',{type:'button',disabled:busy,onClick:()=>setLifecycle({kind:'leave',item})},t('Leave this Hub')):null,
      h('button',{type:'button',disabled:busy,onClick:()=>{setDeleteHistory(false);setLifecycle({kind:'forget',item})}},t('Forget this Hub')),
      selectedHub?.hubId!==item.hubId?h('button',{type:'button',disabled:busy,onClick:()=>{void run(token=>select(item,token))}},t('Select this Hub')):null,
      selectedHub?.hubId===item.hubId&&selectedHub.enabled?h('button',{type:'button',disabled:busy,onClick:()=>{void run(async token=>{await request({endpoint:'disconnect-hub',hubId:item.hubId});if(token===generation.current)await refreshStorage(token)})}},t('Disconnect this Hub')):null,
      selectedHub?.hubId===item.hubId&&item.paused&&item.status==='approved'&&!item.departed?h(Fragment,null,
        h('label',{className:'bt-comm-check'},h('input',{type:'checkbox',checked:Boolean(resumeConfirmed[item.hubId]),onChange:event=>setResumeConfirmed(current=>({...current,[item.hubId]:event.target.checked}))}),t('Resume retained pending messages and work after the Hub checks authorization.')),
        h('button',{type:'button',disabled:busy||!resumeConfirmed[item.hubId],onClick:()=>{void run(async token=>{const value=await request({endpoint:'resume-hub',hubId:item.hubId,confirmedUrl:item.url,confirmResume:true});if(token===generation.current){update(value);setResumeConfirmed({});await refreshStorage(token)}})}},t('Resume this Hub'))):null,
      !item.requestId ? h('p', { role: 'status' }, t('Device identity is saved locally. No request ID exists yet; access has not been requested from the Hub.')) : null,
      item.requestId && ['prepared', 'pending'].includes(item.status) ? h('button', { type: 'button', disabled: busy, onClick: () => { void run(async token => { const value = await request({ endpoint: 'cancel-hub-join', hubId: item.hubId }); if (token === generation.current) update(value) }) } }, t('Cancel request')) : null)),
    h(CommunicationDialog, {open:Boolean(lifecycle),title:lifecycle?.kind === 'leave' ? 'Leave this Hub' : 'Forget this Hub',onClose:()=>setLifecycle(null),busy,error,alert:true,
      actions:h('div',{className:'bt-comm-operation-buttons'},h('button',{type:'button',disabled:busy,onClick:()=>setLifecycle(null),'data-dialog-cancel':true},t('Cancel')),
        h('button',{type:'button',className:'bt-comm-danger',disabled:busy,onClick:()=>{void run(async token=>{
          const item=lifecycle.item
          await request(lifecycle.kind==='leave'?{endpoint:'leave-hub',hubId:item.hubId,confirmedUrl:item.url,confirmLeave:true}:{endpoint:'forget-hub',hubId:item.hubId,confirmedUrl:item.url,confirmForget:true,deleteLocalHistory:deleteHistory,...(deleteHistory?{confirmDeleteLocalHistory:true}:{})})
          if(token===generation.current){setLifecycle(null);await refreshStorage(token)}
        })}},t(lifecycle?.kind==='leave'?'Confirm leaving':'Confirm forgetting')))},
      lifecycle ? h(Fragment,null,h('code',null,lifecycle.item.hubId),h('p',null,lifecycle.item.url),
        h('p',null,t(lifecycle.kind==='leave'?'Revoke server access and group memberships. Chat history stays. Transfer or dissolve groups owned by this device first.':'Delete this Hub configuration, device key and saved CA trust. Leave or cancel pending approval first. Other Hubs are unaffected. Retained history cannot be attached to a new identity.')),
        lifecycle.kind==='forget'?h('label',{className:'bt-comm-check'},h('input',{type:'checkbox',checked:deleteHistory,disabled:busy,onChange:event=>setDeleteHistory(event.target.checked)}),t('Also permanently delete this Hub communication queue and cached files. DSH session journals and browser drafts are retained.')):null) : null),
    liveError ? h('p', { className: 'bt-comm-reference', role: 'status' }, t('Status may be out of date.'), ' ', liveError) : null,
    error ? h('p', { className: 'bt-comm-error', role: 'alert' }, error) : null)
}

function BotChoices({ bots, selected, onChange, label }) {
  return h('fieldset', { className: 'bt-comm-bot-choices' }, h('legend', null, t(label)), bots.length ? bots.map(bot => h('label', { key: bot.id, className: 'bt-comm-check' },
    h('input', { type: 'checkbox', checked: selected.includes(bot.id), onChange: event => onChange(event.target.checked ? [...selected, bot.id] : selected.filter(id => id !== bot.id)), 'data-local-bot-id': bot.id }),
    h(BotMark, { bot, size: 24 }), bot.name, h('span', { className: 'bt-comm-reference' }, bot.id))) : h('p', { className: 'bt-comm-reference' }, t('No published Bots')))
}

const publicProfileActions = { updateBot: (id, changes) => call('update-bot', { id, ...changes }) }

export function OwnRemoteProfile({ request, operation, revision, bots = [] }) {
  const [data, setData] = useState(null), [code, setCode] = useState('')
  const [published, setPublished] = useState([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState('')
  const generation = useRef(0), loadOrder = useRef(0), working = useRef(false), publicationDirty = useRef(false), publicationBase = useRef(null)
  const [liveError, setLiveError] = useState('')
  const load = async () => {
    const token = generation.current, order = ++loadOrder.current
    const results = await Promise.allSettled([
      request({ endpoint: 'user-code' }), request({ endpoint: 'available-bots' }),
    ])
    if (token !== generation.current || order !== loadOrder.current) return
    const [ownCode, available] = results.map(result => result.status === 'fulfilled' ? result.value : null)
    if (ownCode) setCode(ownCode.userCode)
    if (available && !publicationDirty.current) setPublished(available.publishedBotIds ?? [])
    setData(previous => ({ available: available ?? previous?.available ?? { bots: [], publishedBotIds: [] } }))
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  useEffect(() => () => { generation.current += 1; loadOrder.current += 1 }, [request])
  useLiveRefresh(async () => { if (working.current) return; const token = generation.current; await load(); if (token === generation.current) setLiveError('') }, failure => setLiveError(failureLabel(failure)), request, revision)
  const run = async work => {
    if (working.current) return
    working.current = true; loadOrder.current += 1
    const token = ++generation.current
    setBusy(true); setError(''); setLiveError('')
    try { const result = await work(); if (token === generation.current) await load(); return result ?? true }
    catch (failure) {
      if (token === generation.current) {
        setError(failure.code === 'PUBLICATION_CHANGED' ? t('Published Bots changed elsewhere. Your selection is retained. Discard your changes to review the current list before saving again.') : enrollmentFailure(failure))
        if (['CONTACT_VERSION_CONFLICT', 'PUBLICATION_CHANGED'].includes(failure.code)) {
          try { await load() } catch { /* Keep the original conflict; never replay the mutation. */ }
        }
      }
      return false
    }
    finally { working.current = false; if (token === generation.current) setBusy(false) }
  }
  const available = { bots: data?.available?.bots ?? [], publishedBotIds: data?.available?.publishedBotIds ?? [] }
  return h('div', { className: 'bt-comm-own-profile' },
    liveError ? h('p', { className: 'bt-comm-reference', role: 'status' }, t('Status may be out of date.'), ' ', liveError) : null,
    error ? h('p', { className: 'bt-comm-error', role: 'alert' }, error) : null,
    h('h3', null, t('Your user code')), h('p', { className: 'bt-comm-user-code', tabIndex: 0 }, code || t('Loading…')),
    h('p', { className: 'bt-comm-reference' }, t('Share this code with the person you want to add. Contacts can reach your published Bots.')),
    h('button', { type: 'button', disabled: busy || !code, onClick: () => setConfirm('rotate') }, t('Rotate user code')),
    h(CommunicationActionDialog,{open:confirm==='rotate',title:'Rotate user code',confirmLabel:'Confirm code rotation',onClose:()=>setConfirm(''),danger:true,error,onConfirm:()=>run(()=>operation('rotate-user-code',{}))},h('p',null,t('The previous user code will stop working. Existing contacts are retained.'))),
    h('details', { className: 'bt-comm-contact-section', open: true }, h('summary', null, t('Published Bots')), h(BotChoices, { bots: available.bots, selected: published, onChange: value => { if (!publicationDirty.current) publicationBase.current = [...available.publishedBotIds]; publicationDirty.current = true; setPublished(value) }, label: 'Bots available to contacts' }),
      h('button', { type: 'button', disabled: busy || JSON.stringify([...published].sort()) === JSON.stringify([...available.publishedBotIds].sort()), 'data-dirty': JSON.stringify([...published].sort()) !== JSON.stringify([...available.publishedBotIds].sort()), onClick: () => { void run(async () => { await operation('publish-bots', { localBotIds: published, expectedPublishedBotIds: publicationBase.current ?? available.publishedBotIds }); publicationDirty.current = false; publicationBase.current = null }) } }, t('Save published Bots')),
      available.bots.map(item => { const bot = bots.find(bot => bot.id === item.id); return bot ? h('details', { key: item.id, className: 'bt-comm-local-profile' }, h('summary', null, item.name, ' · ', t('Remote profile')), h(BotPublicProfile, { bot, actions: publicProfileActions })) : null }),
      publicationDirty.current ? h('button', { type: 'button', disabled: busy, onClick: () => { publicationDirty.current = false; publicationBase.current = null; setPublished([...available.publishedBotIds]); setError('') } }, t('Discard publication changes')) : null))
}

export function ContactManager({ request, operation, contacts, humanPrincipalId, instanceId, onMessage, messageBusy, addressNotes, onSaveAddressNote, revision, connectionKnown }) {
  const [data, setData] = useState(null), [userCode, setUserCode] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirm, setConfirm] = useState('')
  const generation = useRef(0), loadOrder = useRef(0), working = useRef(false)
  const [liveError, setLiveError] = useState('')
  const load = async () => {
    const token = generation.current, order = ++loadOrder.current
    const results = await Promise.allSettled([request({ endpoint: 'contact-requests' }), request({ endpoint: 'contact-relations' })])
    if (token !== generation.current || order !== loadOrder.current) return
    const [requests, relations] = results.map(result => result.status === 'fulfilled' ? result.value : null)
    setData(previous => ({ requests: requests ?? previous?.requests ?? [], relations: relations ?? previous?.relations ?? [] }))
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  useEffect(() => () => { generation.current += 1; loadOrder.current += 1 }, [request])
  useLiveRefresh(async () => { if (working.current) return; const token = generation.current; await load(); if (token === generation.current) setLiveError('') }, failure => setLiveError(failureLabel(failure)), request, revision)
  const run = async work => {
    if (working.current) return
    working.current = true; loadOrder.current += 1
    const token = ++generation.current
    setBusy(true); setError(''); setLiveError('')
    try { const result = await work(); if (token === generation.current) await load(); return result ?? true }
    catch (failure) {
      if (token === generation.current) {
        setError(failure.code === 'PUBLICATION_CHANGED' ? t('Published Bots changed elsewhere. Your selection is retained. Discard your changes to review the current list before saving again.') : enrollmentFailure(failure))
        if (['CONTACT_VERSION_CONFLICT', 'PUBLICATION_CHANGED'].includes(failure.code)) {
          try { await load() } catch { /* Keep the original conflict; never replay the mutation. */ }
        }
      }
      return false
    }
    finally { working.current = false; if (token === generation.current) setBusy(false) }
  }
  const pending = (data?.requests ?? []).filter(item => item.status === 'pending').length
  return h('div', { className: 'bt-comm-contact-manager' },
    liveError ? h('p', { className: 'bt-comm-reference', role: 'status' }, t('Status may be out of date.'), ' ', liveError) : null,
    error ? h('p', { className: 'bt-comm-error', role: 'alert' }, error) : null,
    h(ContactDirectory, { contacts, relations: data?.relations ?? [], humanPrincipalId, instanceId, request, addressNotes, connectionKnown: liveError ? false : connectionKnown, busy: busy || messageBusy, onMessage, onRemove: item => setConfirm(item) }),
    h(CommunicationActionDialog,{open:Boolean(confirm),title:'Remove contact',confirmLabel:'Confirm contact removal',onClose:()=>setConfirm(''),danger:true,error,onConfirm:()=>run(()=>operation('revoke-contact',{otherHumanPrincipalId:confirm.otherHumanPrincipalId,expectedVersion:confirm.version}))},h('p',null,contacts.find(person=>person.principalId===confirm?.otherHumanPrincipalId)?.displayName ?? confirm?.otherHumanPrincipalId),h('p',null,t('This revokes the contact relationship and access to shared private conversations.'))),
    h(AddressNotes, { contacts, notes: addressNotes, onSave: onSaveAddressNote, busy: busy || messageBusy }),
    h('details', { className: 'bt-comm-contact-section' }, h('summary', null, t('Add a contact')),
    h('label', { className: 'bt-comm-field' }, t('Other user code'), h('input', { value: userCode, maxLength: 64, 'aria-label': t('Other user code'), onChange: event => setUserCode(event.target.value) })),
    h('button', { type: 'button', disabled: busy || !userCode.trim(), onClick: () => { void run(async () => { await operation('request-contact', { userCode }); setUserCode('') }) } }, t('Request contact')),
    ),
    h('details', { className: 'bt-comm-contact-section' }, h('summary', null, t('Contact requests'), pending ? h('span', { className: 'bt-comm-count', 'aria-label': `${pending} ${t('pending')}` }, pending) : null),
    (data?.requests ?? []).map(item => h('section', { key: item.requestId, className: 'bt-comm-address' },
      h('p', { title: item.senderPrincipalId ?? item.requestId }, item.senderPrincipalId ? h(CommunicationAvatar, { person: contacts.find(person => person.principalId === item.senderPrincipalId) ?? { principalId: item.senderPrincipalId, displayName: item.senderName, kind: 'human' }, request, allowed: contacts.some(person => person.principalId === item.senderPrincipalId) }) : null, item.senderName ?? t('Outgoing request'), ' · ', statusLabel(item.status)),
      item.status === 'pending' && item.direction === 'incoming' ? h(Fragment, null,
        h('button', { type: 'button', disabled: busy, onClick: () => { void run(() => operation('accept-contact', { requestId: item.requestId, expectedVersion: item.version })) } }, t('Accept contact')),
        h('button', { type: 'button', disabled: busy, onClick: () => { void run(() => operation('reject-contact', { requestId: item.requestId, expectedVersion: item.version })) } }, t('Reject contact'))) :
        item.status === 'pending' ? h('button', { type: 'button', disabled: busy, onClick: () => { void run(() => operation('cancel-contact', { requestId: item.requestId, expectedVersion: item.version })) } }, t('Cancel request')) : null)),
    !(data?.requests ?? []).length ? h('p', { className: 'bt-comm-reference' }, t('No contact requests')) : null))
}
