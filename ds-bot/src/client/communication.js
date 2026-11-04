import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { createSource } from './sources.js'
import { t } from './i18n.js'
import { MarkdownText } from './dsh-primitives.js'
import { mdLabels } from './btw.js'
import { useLinger } from './motion.js'
import { contactLabels, conversationTitle, deliveryPhase } from './communication-model.js'
import { communicationCSS } from './communication-styles.js'

const OPEN = 'ds-bot:communication:open', SELECTED = 'ds-bot:communication:selected'
const DRAFTS = 'ds-bot:communication:drafts', HIDDEN = 'ds-bot:communication:hidden', ATTEMPTS = 'ds-bot:communication:attempts'
const read = (key, fallback) => { try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback } catch { return fallback } }
const save = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* A full browser store must not prevent sending. */ } }
export async function communicationRequest(body) {
  const response = await fetch('/api/communication', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  if ([401,403].includes(response.status)) throw Object.assign(new Error('INSTANCE_AUTHENTICATION_REQUIRED'), { code: 'INSTANCE_AUTHENTICATION_REQUIRED' })
  const result = await response.json()
  if (!result.ok) throw Object.assign(new Error(result.error?.code ?? 'COMMUNICATION_UNAVAILABLE'), { code: result.error?.code })
  return result.value
}
const friendly = error => ({
  INSTANCE_AUTHENTICATION_REQUIRED: 'This browser session needs the instance startup login.',
  AMBIGUOUS_MENTION: 'Choose the exact participant in the mention picker.', UNKNOWN_MENTION: 'Choose a current participant to mention.',
  PAYLOAD_TOO_LARGE: 'The message exceeds the text limit. Split it into separate messages.', UNSUPPORTED_CONTENT: 'Only text and Markdown are supported.',
  OUTBOX_FULL: 'The send queue is full. Wait for the connection to recover.', NOT_A_MEMBER: 'You are no longer a member of this conversation.',
  MEMBERSHIP_REVOKED: 'Your membership changed. Refresh the conversation.', FORBIDDEN: 'You do not have permission for this group operation.',
  INVALID_REPLY_TARGET: 'That message is not an authorized reply target in this conversation.',
  REFERENCE_NOT_AVAILABLE: 'The referenced message is outside your authorized history.',
  SPEAKING_FORBIDDEN: 'You have read-only access to this group.', PASSIVE_REPLY_REQUIRED: 'This Bot can only reply to an authorized message.',
  PASSIVE_REPLY_ONLY: 'This Bot can only reply to an authorized message.', GROUP_VERSION_CONFLICT: 'Group settings changed. Review the current members and try again.',
  OWNER_TRANSFER_REQUIRED: 'Transfer ownership before leaving or removing the owner.', OWNER_RECLAIM_REQUIRED: 'Restore your retained ownership first.',
  CONVERSATION_PENDING: 'The conversation is waiting for a connection.', COMMUNICATION_READ_ONLY: 'This instance is read-only.',
  UNAUTHENTICATED: 'The Hub rejected this device. Ask the Hub owner to check its pairing.',
  PEER_REVOKED: 'This device was unpaired. Ask the Hub owner to pair it again.',
  AUTHORIZATION_PENDING: 'Membership is still syncing. Wait for the connection to recover.',
  HISTORY_GAP: 'Some history is missing. Wait for synchronization before sending.',
  STALE_CONNECTION: 'Another connection replaced this one. Close the duplicate instance and restart this one.',
  UNSUPPORTED_CAPABILITY: 'This device and the Hub use incompatible versions. Update them to the same revision.',
  TLS_REQUIRED: 'This Hub address requires a secure connection. Ask the Hub owner for its trusted WSS address.',
}[error.code] ?? 'The action could not be confirmed. Refresh status before trying again.')

export function CommunicationSurface({ roster, surface, panel, request = communicationRequest }) {
  const team = useSyncExternalStore(roster.subscribe, roster.getSnapshot)
  const mode = useSyncExternalStore(surface.subscribe, surface.getSnapshot)
  const open = useSyncExternalStore(panel.subscribe, panel.getSnapshot)
  const [shown, closing] = useLinger(open && mode.mode === 'bot', 160)
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [pollError, setPollError] = useState('')
  const [selected, setSelected] = useState(() => read(SELECTED, null))
  const [drafts, setDrafts] = useState(() => read(DRAFTS, {})), [attempts, setAttempts] = useState(() => read(ATTEMPTS, {}))
  const [hidden, setHidden] = useState(() => read(HIDDEN, [])), [showHidden, setShowHidden] = useState(false)
  const [page, setPage] = useState(null), [older, setOlder] = useState(null), [reply, setReply] = useState(null)
  const [referenced, setReferenced] = useState(null), [unavailableReferences, setUnavailableReferences] = useState([])
  const [title, setTitle] = useState(''), [invitees, setInvitees] = useState([]), [invite, setInvite] = useState('')
  const [routing, setRouting] = useState('mentionsOnly'), [admin, setAdmin] = useState(''), [confirm, setConfirm] = useState('')
  const [policies, setPolicies] = useState({}), [newOwner, setNewOwner] = useState('')
  const [browse, setBrowse] = useState(false), [activePanel, setActivePanel] = useState('')
  const input = useRef(null), frame = useRef(null), log = useRef(null), autoScroll = useRef(true), pageOrder = useRef(0), operationIds = useRef(new Map())
  const labels = contactLabels(state?.contacts ?? [], state?.instanceId, t)
  const member = state?.conversations?.find(item => item.conversationId === selected)
  const key = `${state?.instanceId}:${selected}`
  const draft = drafts[key] ?? { text: '', mentions: [] }
  const changeDraft = value => setDrafts(current => { const next = { ...current, [key]: { ...draft, ...value } }; save(DRAFTS, next); return next })
  const close = () => { panel.set(false); save(OPEN, false) }
  const refresh = async () => { const value = await request({ endpoint: 'state' }); setState(value); setPollError(''); return value }
  useEffect(() => {
    if (!team.communicationEnabled) { setState(null); setPollError(''); return undefined }
    let active = true, timer
    const poll = async () => {
      try { const value = await request({ endpoint: 'state' }); if (active) { setState(value); setPollError('') } }
      catch (failure) { if (active) setPollError(friendly(failure)) }
      if (active) timer = setTimeout(() => { void poll() }, 750)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [team.communicationEnabled, request])
  useEffect(() => {
    if (!shown) return undefined
    const visible = node => !node.checkVisibility || node.checkVisibility()
    const controls = () => [...(frame.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary') ?? [])]
      .filter(node => visible(node) && (!node.closest('details:not([open])') || node.tagName === 'SUMMARY'))
    const focusDefault = () => (input.current && !input.current.disabled && visible(input.current) ? input.current : controls()[0])?.focus()
    focusDefault()
    const retain = event => { if (frame.current && !frame.current.contains(event.target)) focusDefault() }
    const keys = event => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        const members = frame.current?.querySelector('.bt-comm-members[open]')
        if (members) { members.open = false; focusDefault() } else close()
      }
      if (event.key === 'Tab') {
        const targets = controls(), first = targets[0], last = targets.at(-1)
        if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus()
        }
      }
    }
    document.addEventListener('focusin', retain, true)
    document.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('focusin', retain, true); document.removeEventListener('keydown', keys, true) }
  }, [shown, browse, selected, member?.speakingMode])
  useEffect(() => {
    if (!shown || !activePanel) return
    const section = frame.current?.querySelector(`details[data-panel="${activePanel}"]`)
    section?.scrollIntoView?.({ block: 'nearest' })
    section?.querySelector(activePanel === 'group' ? 'input' : 'button')?.focus()
  }, [shown, activePanel])
  useEffect(() => { save(SELECTED, selected); setOlder(null); setReply(null); setReferenced(null); setConfirm(''); setNewOwner(''); setPolicies({}); autoScroll.current = true; input.current?.focus() }, [selected])
  useLayoutEffect(() => {
    const target = referenced && [...(log.current?.querySelectorAll('article') ?? [])].find(node => node.dataset.messageId === referenced)
    if (target) target.scrollIntoView?.({ block: 'center' })
    else if (log.current && older === null && autoScroll.current) log.current.scrollTop = log.current.scrollHeight
  }, [page, older, referenced, state?.outbox])
  useEffect(() => { setRouting(member?.routingMode ?? 'mentionsOnly'); setAdmin(member?.adminBotPrincipalId ?? '') }, [selected, member?.membershipVersion])
  useEffect(() => {
    if (!shown || !member) { setPage(null); return undefined }
    let active = true
    const order = ++pageOrder.current
    void request({ endpoint: 'history', conversationId: selected, limit: 50, ...(older === null ? {} : { before: older }) }).then(value => {
      if (active && pageOrder.current === order) setPage(value)
    }).catch(failure => { if (active) { setPage(null); setError(friendly(failure)) } })
    return () => { active = false }
  }, [shown, selected, member?.membershipEpoch, older, older === null ? member?.watermark : null, request])
  useEffect(() => {
    if (!shown || page?.conversationId !== selected || !page.events.length) return undefined
    const mark = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void request({ endpoint: 'read', conversationId: selected, seq: page.events.at(-1).conversationSeq }).catch(failure => setError(friendly(failure)))
    }
    mark(); window.addEventListener('focus', mark); document.addEventListener('visibilitychange', mark)
    return () => { window.removeEventListener('focus', mark); document.removeEventListener('visibilitychange', mark) }
  }, [shown, selected, page, request])
  const operation = async (endpoint, values) => {
    const current = state?.conversations?.find(item => item.conversationId === values.conversationId)
    if (current && !['reclaim','dm','create-group','accept'].includes(endpoint)) values = { membershipEpoch: current.membershipEpoch, expectedVersion: current.membershipVersion, ...values }
    const operationKey = JSON.stringify([endpoint, values])
    if (!operationIds.current.has(operationKey)) operationIds.current.set(operationKey, crypto.randomUUID())
    const value = await request({ endpoint, ...values, operationId: operationIds.current.get(operationKey) })
    if (value.status !== 'queued') operationIds.current.delete(operationKey)
    await refresh()
    return value
  }
  const act = async work => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (failure) { setError(friendly(failure)) } finally { setBusy(false) }
  }
  const send = () => act(async () => {
    if (!member || !draft.text.trim()) return
    const intent = attempts[key] ?? { endpoint: 'send', conversationId: selected, membershipEpoch: member.membershipEpoch, messageId: crypto.randomUUID(), clientCreatedAt: new Date().toISOString(),
      text: draft.text, mentions: draft.mentions, replyToMessageId: reply?.messageId ?? null }
    const next = { ...attempts, [key]: intent }; save(ATTEMPTS, next); setAttempts(next)
    try { await request(intent) } catch (failure) {
      if (failure.code) { delete next[key]; save(ATTEMPTS, next); setAttempts({ ...next }) }
      throw failure
    }
    delete next[key]; save(ATTEMPTS, next); setAttempts({ ...next })
    changeDraft({ text: '', mentions: [] }); setReply(null)
    await refresh(); input.current?.focus()
  })
  const choose = id => {
    const next = hidden.filter(item => item !== `${state?.instanceId}:${id}`)
    save(HIDDEN, next); setHidden(next); setSelected(id); setBrowse(false); setError('')
  }
  const hide = () => { const next = [...new Set([...hidden, key])]; save(HIDDEN, next); setHidden(next); setSelected(null) }
  const openReference = messageId => act(async () => {
    try {
      const event = await request({ endpoint: 'reference', conversationId: selected, messageId })
      setReferenced(messageId)
      if (!page?.events.some(item => item.message?.messageId === messageId)) setOlder(event.conversationSeq + 24)
    } catch (failure) {
      if (failure.code === 'REFERENCE_NOT_AVAILABLE') setUnavailableReferences(current => [...new Set([...current, messageId])])
      throw failure
    }
  })
  const btn = (label, onClick, props = {}) => h('button', { type: 'button', disabled: busy, onClick, ...props }, props.children ?? t(label))
  const chooseContact = (label, value, onChange, contacts) => h('label', { className: 'bt-comm-field' }, t(label),
    h('select', { value, onChange: event => onChange(event.target.value), 'aria-label': t(label) },
      h('option', { value: '' }, t('Choose a participant')),
      contacts.map(contact => h('option', { key: contact.principalId, value: contact.principalId }, labels.get(contact.principalId) ?? contact.displayName))))
  if (!shown) return null
  const events = page?.conversationId === selected && page?.membershipEpoch === member?.membershipEpoch ? page.events : []
  const visibleIds = new Set(events.map(event => event.message?.messageId))
  const ownOutbox = member ? (state?.outbox ?? []).filter(item => item.type === 'message.publish' && item.conversationId === selected) : []
  const currentMembers = member?.info?.members ?? []
  const isOwner = member?.role === 'owner', canManage = ['owner','admin'].includes(member?.role)
  const canSpeak = member && (member.kind !== 'group' || member.speakingMode === 'speak')
  const contacts = state?.contacts ?? []
  const operations = state?.outbox?.filter(item => item.type !== 'message.publish' && item.state !== 'accepted') ?? []
  const pendingCount = (state?.outbox ?? []).filter(item => item.type === 'message.publish' && item.state === 'pending').length
  const remoteCount = contacts.filter(contact => contact.homeInstanceId !== state?.instanceId).length
  const showPanel = name => { setActivePanel(name); setBrowse(true) }
  const connectionBlocked = state?.error && !['CONNECTION_LOST','REQUEST_TIMEOUT','STORAGE_UNAVAILABLE','BACKPRESSURE','HISTORY_GAP'].includes(state.error)
  const connectionLabel = !team.communicationEnabled ? 'Not configured' : pollError ? 'Cannot reach this instance' : !state ? 'Connecting…' : state.connected ? 'Connected to Hub' : connectionBlocked ? 'Connection needs attention' : 'Reconnecting to Hub'
  const roleLabel = role => role === 'owner' ? 'Group owner' : role === 'admin' ? 'Group admin' : 'Group member'
  const speechLabel = person => person.speakingMode === 'readOnly' ? 'Read only' : person.speakingMode === 'passive' ? 'Reply only' : 'Can speak'
  const panelToggle = name => event => { if (event.target === event.currentTarget) setActivePanel(event.currentTarget.open ? name : current => current === name ? '' : current) }
  return createPortal(h('section', { ref: frame, className: 'bt-comm-frame', role: 'dialog', 'aria-modal': true, 'data-closing': closing, 'data-browse': browse || !member, 'data-setup': !team.communicationEnabled, 'aria-label': t('Communication') },
    h('aside', { className: 'bt-comm-nav' },
      h('div', { className: 'bt-comm-nav-heading' }, h('h2', null, t('Communication')), btn('Back to local chats', close, { className: 'bt-comm-back' })),
      member ? btn('Back to conversation', () => setBrowse(false), { className: 'bt-comm-mobile' }) : null,
      h('section', { className: 'bt-comm-connection', 'aria-label': t('Connection status') },
        h('p', { className: 'bt-comm-connection-label', role: 'status', 'data-connected': Boolean(state?.connected && !pollError) }, h('span', { className: 'bt-comm-dot', 'aria-hidden': true }), t(connectionLabel)),
        state ? h('p', { className: 'bt-comm-reference' }, `${state.instanceId} · ${t('Remote contacts')}: ${remoteCount}`) : null,
        team.communicationEnabled && !state?.connected && !connectionBlocked ? h('p', { className: 'bt-comm-reference' }, t('Queued messages send automatically when the connection returns.')) : null,
        state?.error ? h('p', { className: 'bt-comm-error', role: 'alert' }, t(friendly({ code: state.error }))) : null,
        team.communicationEnabled ? btn('Refresh status', () => { void act(refresh) }) : null,
        state ? h('details', { className: 'bt-comm-identity' }, h('summary', null, t('Connection details')),
          h('p', null, t('This device')), h('code', null, state.instanceId),
          h('p', null, t('Your identity')), h('code', null, state.humanPrincipalId),
          state.error ? h(Fragment, null, h('p', null, t('Error code')), h('code', null, state.error)) : null) : null),
      h('div', { className: 'bt-comm-start-actions' },
        btn('New message', () => showPanel('contacts'), { disabled: busy || !team.communicationEnabled }),
        btn('New group', () => showPanel('group'), { className: 'bt-comm-primary', disabled: busy || !team.communicationEnabled })),
      h('div', { className: 'bt-comm-section-title' }, t('Conversations'), h('span', null, state?.conversations?.length ?? 0)),
      h('nav', { 'aria-label': t('Communication conversations') }, (state?.conversations ?? []).filter(item => showHidden || !hidden.includes(`${state.instanceId}:${item.conversationId}`)).map(item =>
        btn(conversationTitle(item, state.humanPrincipalId, labels), () => choose(item.conversationId), { key: item.conversationId, 'aria-pressed': item.conversationId === selected,
          title: item.conversationId, children: h(Fragment, null, h('span', { className: 'bt-comm-conversation-name' }, conversationTitle(item, state.humanPrincipalId, labels)),
            item.unread ? h('span', { className: 'bt-comm-unread', 'aria-label': `${item.unread} ${t('Unread')}` }, item.unread) : null) }))),
      !state?.conversations?.length ? h('p', { className: 'bt-comm-reference' }, t('Your cross-device conversations will appear here.')) : null,
      btn(showHidden ? 'Hide closed conversations' : 'Show closed conversations', () => setShowHidden(value => !value)),
      h('details', { 'data-panel': 'contacts', open: activePanel === 'contacts', onToggle: panelToggle('contacts') }, h('summary', null, t('Contacts')), contacts.filter(contact => contact.principalId !== state?.humanPrincipalId).map(contact =>
        btn(labels.get(contact.principalId), () => { void act(async () => { const value = await operation('dm', { otherPrincipalId: contact.principalId }); if (value.conversationId) choose(value.conversationId) }) }, { key: contact.principalId, title: contact.principalId, className: 'bt-comm-contact' })),
        !contacts.some(contact => contact.homeInstanceId !== state?.instanceId) ? h('p', { className: 'bt-comm-reference' }, t('Remote contacts appear after the other device connects and publishes its identities.')) : null),
      h('details', { 'data-panel': 'group', open: activePanel === 'group', onToggle: panelToggle('group') }, h('summary', null, t('Create communication group')),
        h('label', { className: 'bt-comm-field' }, t('Group name'), h('input', { value: title, onChange: event => setTitle(event.target.value), 'aria-label': t('Group name') })),
        h('p', { className: 'bt-comm-reference' }, t('You will own this group. Invitees join after accepting.')),
        contacts.filter(contact => contact.principalId !== state?.humanPrincipalId).map(contact => h('label', { key: contact.principalId, className: 'bt-comm-check' },
          h('input', { type: 'checkbox', checked: invitees.includes(contact.principalId), onChange: event => setInvitees(current => event.target.checked ? [...current, contact.principalId] : current.filter(id => id !== contact.principalId)) }), labels.get(contact.principalId))),
        btn('Create and invite', () => { void act(async () => { const value = await operation('create-group', { title }); if (!value.conversationId) return
          choose(value.conversationId); setTitle(''); setInvitees([]); setActivePanel('')
          try { for (const inviteePrincipalId of invitees) await operation('invite', { conversationId: value.conversationId, inviteePrincipalId }) }
          catch { setError('Group created. Some invitations were not sent. Open the member settings to invite them.') }
        }) }, { className: 'bt-comm-primary', disabled: busy || !team.communicationEnabled || !title.trim() }),
        h('p', { className: 'bt-comm-reference' }, t('New members start read-only or reply-only. Change permissions in the member settings.'))),
      state?.invites?.length ? h('div', null, h('h3', null, t('Invitations')), state.invites.map(invitation => h('div', { key: invitation.inviteId },
        h('p', null, `${invitation.title} · ${labels.get(invitation.principalId) ?? invitation.principalId}`),
        btn('Accept invitation', () => { void act(() => operation('accept', { inviteId: invitation.inviteId, recipientPrincipalId: invitation.principalId })) })))) : null,
      (state?.recoverableOwnership ?? []).map(item => h('div', { key: item.conversationId }, h('p', null, item.title),
        btn('Restore retained ownership', () => { void act(() => operation('reclaim', { conversationId: item.conversationId, expectedVersion: item.membershipVersion })) }))),
      operations.map(item => h('p', { key: item.id, role: 'status', className: item.state === 'failed' ? 'bt-comm-error' : 'bt-comm-reference' },
        t(item.state === 'failed' ? 'Operation failed' : 'Operation queued'), ' · ', item.error ? t(friendly({ code: item.error })) : t('Waiting for the Hub')))),
    h('main', { className: 'bt-comm-main' },
      h('header', null,
        member ? btn('Conversations', () => setBrowse(true), { className: 'bt-comm-mobile' }) : null,
        !team.communicationEnabled ? btn('Back to local chats', close, { className: 'bt-comm-mobile' }) : null,
        h('div', { className: 'bt-comm-heading' }, h('h2', null, member ? conversationTitle(member, state.humanPrincipalId, labels) : t('Cross-device conversations')),
          member ? h('p', { className: 'bt-comm-reference' }, member.kind === 'group' ? `${currentMembers.length} ${t('Members')} · ${t(roleLabel(member.role))} · ${t(speechLabel(member))}` : t('Private conversation')) : null),
        member ? btn('Close on this device', hide) : null),
      !member ? h('section', { className: 'bt-comm-empty' },
        h('span', { className: 'bt-comm-empty-symbol', 'aria-hidden': true }, '↔'),
        h('h2', null, t(team.communicationEnabled ? 'Start a conversation across devices' : 'Pair this device to get started')),
        h('p', null, t(team.communicationEnabled ? 'Message a Human or Bot directly, or bring them together in a group.' : 'Ask the Hub owner to configure communication and pair this device.')),
        team.communicationEnabled ? h('div', { className: 'bt-comm-start-actions' }, btn('New message', () => showPanel('contacts')), btn('New group', () => showPanel('group'), { className: 'bt-comm-primary' })) : null,
        h('p', { className: 'bt-comm-reference' }, t('Local chats stay separate from communication conversations.'))) : null,
      member?.kind === 'group' ? h('details', { className: 'bt-comm-members' }, h('summary', null, t('Group members and receiving rules')),
        btn('Close member settings', event => { const details = event.currentTarget.closest('details'); details.open = false; details.querySelector('summary')?.focus() }, { className: 'bt-comm-members-close' }),
        h('p', { className: 'bt-comm-reference' }, t('Roles control group management. Speaking permissions control who can send.')),
        member.ownerPrincipalId && !currentMembers.some(person => person.principalId === member.ownerPrincipalId) ? h('p', { role: 'status' }, t('The owner is unavailable. Ownership stays with that identity.')) : null,
        !member.ownerPrincipalId ? h('p', { role: 'status' }, t('This legacy group has no retained owner. No automatic takeover is allowed.')) : null,
        currentMembers.map(person => {
          const editable = isOwner || member.role === 'admin' && person.role === 'member'
          const policyKey = `${selected}:${member.membershipVersion}:${person.principalId}`
          const policy = policies[policyKey] ?? { role: person.role, speakingMode: person.speakingMode }
          const changePolicy = values => setPolicies(current => ({ ...current, [policyKey]: { ...policy, ...values } }))
          return h('div', { key: person.principalId, className: 'bt-comm-person', 'data-principal-id': person.principalId },
            h('span', { title: person.principalId }, labels.get(person.principalId) ?? person.displayName),
            h('span', { className: 'bt-comm-role' }, t(roleLabel(person.role))),
            editable ? h(Fragment, null,
              isOwner && person.role !== 'owner' ? h('label', null, t('Group role'), h('select', { value: policy.role, 'aria-label': t('Group role'), onChange: event => changePolicy({ role: event.target.value }) },
                h('option', { value: 'member' }, t('Group member')), h('option', { value: 'admin' }, t('Group admin')))) : null,
              h('label', null, t('Speaking permission'), h('select', { value: policy.speakingMode, 'aria-label': t('Speaking permission'), onChange: event => changePolicy({ speakingMode: event.target.value }) },
                (person.kind === 'human' ? [['readOnly','Read only'],['speak','Can speak']] : [['passive','Reply only'],['active','Can speak']]).map(([value,label]) => h('option', { key: value, value }, t(label))))),
              btn('Save member permissions', () => { void act(() => operation('policy', { conversationId: selected, targetPrincipalId: person.principalId, expectedVersion: member.membershipVersion,
                speakingMode: policy.speakingMode, ...(isOwner && person.role !== 'owner' ? { role: policy.role } : {}) })) })) : h('span', null, t(['readOnly','passive'].includes(person.speakingMode) ? person.kind === 'human' ? 'Read only' : 'Reply only' : 'Can speak')),
            canManage && person.role !== 'owner' && (isOwner || person.role === 'member') && person.principalId !== state.humanPrincipalId ? btn('Remove from group', () => { void act(() => operation('remove', { conversationId: selected, targetPrincipalId: person.principalId })) }) : null)
        }),
        h('p', { className: 'bt-comm-reference' }, t('Reply-only Bots respond to admitted messages. Bots allowed to speak may also initiate messages.')),
        canManage ? h(Fragment, null,
          chooseContact('Invite participant', invite, setInvite, contacts.filter(contact => !currentMembers.some(person => person.principalId === contact.principalId))),
          btn('Invite', () => { void act(() => operation('invite', { conversationId: selected, inviteePrincipalId: invite })) }, { disabled: busy || !invite }),
          h('label', { className: 'bt-comm-field' }, t('Receiving rule'), h('select', { value: routing, onChange: event => setRouting(event.target.value), 'aria-label': t('Receiving rule') },
            h('option', { value: 'mentionsOnly' }, t('Mentions only')), h('option', { value: 'admin' }, t('Plain messages go to one Bot')))),
          routing === 'admin' ? chooseContact('Default reply Bot', admin, setAdmin, currentMembers.filter(person => person.kind === 'bot')) : null,
          btn('Save receiving rule', () => { void act(() => operation('routing', { conversationId: selected, mode: routing, adminBotPrincipalId: admin || null })) })) : h('p', null, t(member.routingMode === 'admin' ? 'Plain messages go to one Bot' : 'Mentions only')),
        isOwner ? h(Fragment, null,
          chooseContact('Transfer ownership to', newOwner, value => { setNewOwner(value); setConfirm('') }, currentMembers.filter(person => person.principalId !== state.humanPrincipalId)),
          btn(confirm === 'transfer' ? 'Confirm ownership transfer' : 'Transfer ownership', () => { if (confirm !== 'transfer') setConfirm('transfer'); else void act(() => operation('transfer', { conversationId: selected, targetPrincipalId: newOwner, expectedVersion: member.membershipVersion })) }, { disabled: busy || !newOwner })) : null,
        btn(confirm === 'leave' ? 'Confirm leaving group' : 'Leave group', () => { if (confirm !== 'leave') setConfirm('leave'); else void act(() => operation('remove', { conversationId: selected })) }, { disabled: busy || isOwner, title: isOwner ? t('Transfer ownership before leaving') : undefined }),
        isOwner ? btn(confirm === 'dissolve' ? 'Confirm ending group for everyone' : 'End group for everyone', () => { if (confirm !== 'dissolve') setConfirm('dissolve'); else void act(() => operation('dissolve', { conversationId: selected })) }, { className: 'bt-comm-danger' }) : null) : null,
      h('div', { ref: log, className: 'bt-comm-log', role: 'log', 'aria-label': t('Communication messages'), onScroll: event => {
        const element = event.currentTarget; autoScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      } },
        member && events.length > 0 && events[0].conversationSeq > member.joinSeq ? btn('Load earlier messages', () => setOlder(events[0].conversationSeq - 1)) : null,
        older !== null ? btn('Show latest messages', () => setOlder(null)) : null,
        events.map(event => event.type !== 'message' ? h('p', { key: event.eventId, className: 'bt-comm-event' }, t('Membership or receiving rule changed')) : h('article', { key: event.message.messageId, 'data-message-id': event.message.messageId, 'data-self': event.message.author.principalId === state.humanPrincipalId, 'data-referenced': event.message.messageId === referenced },
          h('strong', { title: event.message.author.principalId }, event.message.author.principalId === state.humanPrincipalId ? t('You · Human') : labels.get(event.message.author.principalId) ?? event.message.author.principalId),
          event.message.replyToMessageId ? h('div', { className: 'bt-comm-reference' }, btn(unavailableReferences.includes(event.message.replyToMessageId) ? 'Earlier message unavailable' : 'Open referenced message',
            () => { void openReference(event.message.replyToMessageId) }, { disabled: busy || unavailableReferences.includes(event.message.replyToMessageId), title: event.message.replyToMessageId })) : null,
          h('div', { className: 'bt-comm-body' }, h(MarkdownText, { text: event.message.content.text, labels: mdLabels(), variant: 'compact' })),
          event.message.mentions.length ? h('p', { className: 'bt-comm-reference' }, event.message.mentions.map(mention => `@${labels.get(mention.principalId) ?? mention.principalId}`).join(' · ')) : null,
          h('div', { className: 'bt-comm-message-actions' }, h('time', null, new Date(event.serverAcceptedAt).toLocaleString()), btn('Reply', () => { setReply(event.message); input.current?.focus() })),
          ownOutbox.find(item => item.id === event.message.messageId)?.deliveries.filter(delivery => delivery.recipientPrincipalId !== state.humanPrincipalId).map(delivery => h('p', { key: delivery.deliveryId, className: 'bt-comm-reference' }, `${labels.get(delivery.recipientPrincipalId) ?? delivery.recipientPrincipalId} · ${t(deliveryPhase(delivery))}`)))),
        ownOutbox.filter(item => !visibleIds.has(item.id) && (item.state !== 'accepted' || older === null && item.result?.conversationSeq > (page?.watermark ?? 0))).map(item => h('article', { key: item.id, 'data-message-id': item.id, 'data-self': true, 'data-failed': item.state === 'failed' },
          h('strong', null, t('You · Human')), h('p', { className: 'bt-comm-pending-text' }, item.text), h('p', { role: 'status' }, t(item.state === 'accepted' ? 'Hub accepted' : item.state === 'failed' ? 'Send failed' : 'Queued on this device'), item.error ? ` · ${t(friendly({ code: item.error }))}` : '')))),
      member ? h('footer', null,
        pendingCount ? h('p', { className: 'bt-comm-reference', role: 'status' }, `${pendingCount} · ${t('Queued messages send automatically when the connection returns.')}`) : null,
        attempts[key] ? h('p', { className: 'bt-comm-error', role: 'alert' }, t('Send not confirmed. Retry the same message to avoid sending it twice.')) : null,
        reply ? h('div', { className: 'bt-comm-reference' }, `${t('Reply to')} ${reply.content.text.slice(0,120)}`, btn('Cancel reply', () => setReply(null))) : null,
        h('div', { className: 'bt-comm-mentions' }, (draft.mentions ?? []).map(id => btn(`@${labels.get(id) ?? id} ×`, () => changeDraft({ mentions: draft.mentions.filter(item => item !== id) }), { key: id }))),
        h('details', null, h('summary', null, t('Mention participant')), chooseContact('Mention participant', '', id => { if (id) changeDraft({ mentions: [...new Set([...(draft.mentions ?? []), id])] }) }, currentMembers)),
        h('label', { className: 'bt-comm-field' }, t('Communication message'), h('textarea', { ref: input, value: draft.text, rows: 3, disabled: !canSpeak || Boolean(attempts[key]),
          onChange: event => changeDraft({ text: event.target.value }), onKeyDown: event => {
            event.stopPropagation()
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
          }, onPaste: event => { if (event.clipboardData?.files.length) { event.preventDefault(); setError('Only text and Markdown are supported.') } },
          onDrop: event => { event.preventDefault(); setError('Only text and Markdown are supported.') }, 'aria-label': t('Communication message') })),
        btn(attempts[key] ? 'Retry same send' : 'Send message', () => { void send() }, { disabled: busy || !canSpeak || !draft.text.trim() }),
        !canSpeak ? h('p', { role: 'status' }, t('You have read-only access to this group.')) : null,
        h('span', { className: 'bt-comm-reference' }, t('Enter to send · Shift+Enter for a new line')),
        h('details', { className: 'bt-comm-status-help' }, h('summary', null, t('About message status')),
          h('p', null, t('Stored means the destination saved the message. Read means a Human opened it. Bot admitted means processing was accepted, not that a reply is complete.')),
          h('p', null, t('Text and Markdown · attachments unavailable')))) : null,
      error ? h('p', { className: 'bt-comm-error', role: 'alert' }, t(error)) : null,
      pollError ? h('p', { className: 'bt-comm-error', role: 'alert' }, t(pollError)) : null,
      state?.errors?.filter(item => item.conversationId === selected).map(item => h('p', { key: item.bindingId, className: 'bt-comm-error', role: 'alert' }, `${t('Bot delivery needs reconciliation')} · ${item.code}`)),
      state?.exportFailures?.filter(item => item.conversationId === selected).map(item => h('p', { key: item.messageId, className: 'bt-comm-error', role: 'alert' }, `${t('Send failed')} · Bot ${item.messageId}: ${item.code}`)))), document.body)
}

export function installCommunication(ctx, { roster, surface }) {
  const panel = createSource(read(OPEN, false))
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = communicationCSS; document.head.append(style)
    return () => style.remove()
  }, 'ds-bot: communication styles')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'bot-communication', order: 52 },
    () => h(CommunicationSurface, { roster, surface, panel })))
  return { open: () => { save(OPEN, true); panel.set(true) } }
}
