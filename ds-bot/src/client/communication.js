import { randomId } from './random-id.js'
import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { createSource } from './sources.js'
import { t } from './i18n.js'
import { useLinger, useViewport, viewBottom, SPRING_TAP } from './motion.js'
import { contactLabels, conversationTitle, contactsByAddress, mentionQuery, mentionChoices, insertMention, retainedMentions, groupSettingsValues, groupSettingsChanges, referenceExcerpt, communicationLogEvents, communicationScope } from './communication-model.js'
import { AddDevice, ContactManager } from './communication-onboarding.js'
import { CommunicationAvatar, HumanProfile, syncAvatarDirectory } from './communication-profile.js'
import { CommunicationMessage, BotWorkStarted } from './communication-message.js'
import { selectedAttachments } from './communication-attachments.js'
import { ConversationRow, ConversationAvatar } from './communication-list.js'
import { CommunicationActivity } from './communication-activity.js'
import { CommunicationThread, ThreadReplyComposer } from './communication-thread.js'
import { CommunicationMemory } from './communication-memory.js'
import { CommunicationMessageActions } from './communication-message-actions.js'
import { GearIcon, ArrowUpIcon, CloseIcon, InfoIcon, PeopleIcon, ChatsIcon, SearchIcon, PlusIcon, SidebarIcon, ChevronLeftIcon } from './icons.js'
import { communicationCSS } from './communication-styles.js'
import { communicationFailure as friendly, operationOutcomeUncertain } from './communication-errors.js'
import { liveRefresh } from './communication-live.js'

const OPEN = 'ds-bot:communication:open', SELECTED = 'ds-bot:communication:selected'
const SIDEBAR_HIDDEN = 'ds-bot:communication:sidebar-hidden'
const OPERATION_IDS = 'ds-bot:communication:operation-ids'
const DRAFTS = 'ds-bot:communication:drafts', ATTEMPTS = 'ds-bot:communication:attempts'
const read = (key, fallback) => { try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback } catch { return fallback } }
const save = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* A full browser store must not prevent sending. */ } }
const readOperationIds = () => {
  const entries = read(OPERATION_IDS, [])
  const current = entries.filter(([key]) => { try { return JSON.parse(key)?.[1] !== 'reclaim' } catch { return true } })
  if (current.length !== entries.length) save(OPERATION_IDS, current)
  return current
}
export async function communicationRequest(body) {
  const response = await fetch('/api/communication', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  if ([401,403].includes(response.status)) throw Object.assign(new Error('INSTANCE_AUTHENTICATION_REQUIRED'), { code: 'INSTANCE_AUTHENTICATION_REQUIRED' })
  const result = await response.json()
  if (!result.ok) throw Object.assign(new Error(result.error?.code ?? 'COMMUNICATION_UNAVAILABLE'), { code: result.error?.code, phase: result.error?.phase })
  return result.value
}
const hubPairingExample = JSON.stringify({ peers: [{ instanceId: 'new-device', instanceLabel: 'New device', pairingRevision: 1, credentialEnv: 'DSBOT_HUB_NEW_DEVICE_CREDENTIAL' }] }, null, 2)
const clientPairingExample = `communication:
  enabled: true
  instanceId: new-device
  url: wss://hub.example.test:3190/communication
  credentialEnv: DSBOT_COMMUNICATION_CREDENTIAL
  humanDisplayName: New device Human
  publishedBotIds: [REPLACE_WITH_LOCAL_BOT_ID]`

function PairingGuide({ connectionLabel }) {
  return h('div', { className: 'bt-comm-pairing-guide' },
    h('p', null, t('The Hub owner must authorize each device in the Hub configuration and restart the Hub. This guide does not pair a device or change permissions.')),
    h('h3', null, t('1. Hub owner')),
    h('ol', null,
      h('li', null, t('Agree on a unique, stable instanceId for the new device. Keep existing peer entries and add the new peer to the Hub configuration.')),
      h('li', null, t('Use credentialEnv to name a private environment variable. The Hub and this device need the same dedicated pairing credential value, supplied privately through each local secret mechanism. The environment variable names may differ.')),
      h('li', null, t('Provide a reachable trusted WSS address whose certificate matches its hostname. Restart the Hub with the updated peer configuration and its private launch environment.'))),
    h('pre', { 'aria-label': t('Hub configuration example') }, h('code', null, hubPairingExample)),
    h('h3', null, t('2. New device')),
    h('ol', null,
      h('li', null, t('Quit the app, including its tray process. Merge the communication settings into the existing bot configuration in your own profile cordis.patch.yml. Use the exact instanceId approved by the Hub owner.')),
      h('li', null, t('Set the trusted WSS url, credentialEnv, humanDisplayName and publishedBotIds. Publish only Bot IDs from this device that you intend to make available. Each instance has one person identity; rename it under Personal settings.')),
      h('li', null, t('Supply the pairing credential to the app launch environment through your local secret mechanism, then restart the app. Never put the value in configuration, command arguments, URLs, screenshots or chat.'))),
    h('pre', { 'aria-label': t('Device configuration example') }, h('code', null, clientPairingExample)),
    h('h3', null, t('3. Verify the connection')),
    h('p', { role: 'status' }, t('This device'), ': ', t(connectionLabel)),
    h('p', null, t('Open Remote communication on both devices. Check Connected to Hub, then New message: verify the other device’s Human and published Bots under its observed IP and exact instance identity. A shared IP does not merge devices.')),
    h('p', null, t('If disconnected, check the exact instanceId, matching privately supplied credential, trusted certificate and hostname, and Hub restart. Readiness alone does not prove pairing. Revoked devices need the Hub owner to increase pairingRevision before re-pairing.')))
}

function ReferenceQuote({ conversationId, membershipEpoch, messageId, request, labels, onJump }) {
  const [source, setSource] = useState(null), [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    let active = true
    setSource(null); setUnavailable(false)
    void request({ endpoint: 'reference', conversationId, messageId }).then(event => {
      if (active && event?.message?.messageId === messageId) setSource(event.message)
      else if (active) setUnavailable(true)
    }).catch(() => { if (active) setUnavailable(true) })
    return () => { active = false }
  }, [conversationId, membershipEpoch, messageId, request])
  return h('button', { type: 'button', className: 'bt-comm-quote', 'data-reference-id': messageId, disabled: !source || unavailable,
    'aria-label': t('Jump to source message'), onClick: () => { void onJump(messageId) } },
    source ? h(Fragment, null, h('span', { className: 'bt-comm-quote-author' }, labels.get(source.author.principalId) ?? source.author.displayName ?? t('Participant')),
      h('span', { className: 'bt-comm-quote-text' }, referenceExcerpt(source.content.text))) : t(unavailable ? 'Earlier message unavailable' : 'Loading reference…'))
}

function GroupSettings({ member, contacts, operation, pendingSettings, operationPending, act, busy, humanId, btn, personLabel, chooseContact }) {
  const [open, setOpen] = useState(false), [base, setBase] = useState(null), [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState(''), [pending, setPending] = useState(null)
  const [invite, setInvite] = useState(''), [newOwner, setNewOwner] = useState(''), [confirm, setConfirm] = useState('')
  const generation = useRef(0), revision = useRef(0), summary = useRef(null)
  useEffect(() => () => { generation.current += 1 }, [])
  useEffect(() => { if (pending && !pendingSettings(member.conversationId)) setPending(null) }, [operationPending, member.membershipVersion])
  const isOwner = member.role === 'owner', canManage = ['owner', 'admin'].includes(member.role)
  const members = member.info?.members ?? []
  const close = () => { generation.current += 1; setOpen(false); setBase(null); setDraft(null); setFailure(''); setSaving(false); setPending(null); summary.current?.closest('main')?.querySelector('.bt-comm-title-pill')?.focus() }
  const begin = () => {
    generation.current += 1; revision.current = 0
    const values = groupSettingsValues(member)
    setBase({ values, expectedVersion: member.membershipVersion, membershipEpoch: member.membershipEpoch })
    setDraft(values); setFailure(''); setPending(pendingSettings(member.conversationId)); setSaving(false); setOpen(true)
  }
  const edit = values => { revision.current += 1; setDraft(current => ({ ...current, ...values })) }
  const changes = base && draft ? groupSettingsChanges(base.values, draft) : {}
  const dirty = Object.keys(changes).length > 0
  const saveSettings = async () => {
    if (saving || !base || !draft || !dirty && !pending) return
    const token = generation.current, editedAt = revision.current
    const intent = pending ?? { conversationId: member.conversationId, membershipEpoch: base.membershipEpoch, expectedVersion: base.expectedVersion, ...changes }
    setSaving(true); setFailure('')
    try {
      const result = await operation('save-settings', intent)
      if (token !== generation.current) return
      if (result.status === 'queued') { setPending(intent); return }
      const canonical = result.refreshedState?.conversations?.find(item => item.conversationId === member.conversationId && item.membershipVersion === result.membershipVersion)
      const savedValues = canonical ? groupSettingsValues(canonical) : {
        ...base.values, ...(intent.title === undefined ? {} : { title: intent.title }), ...(intent.routing ? { routing: intent.routing } : {}),
        policies: { ...base.values.policies, ...Object.fromEntries((intent.policies ?? []).map(policy => [policy.targetPrincipalId, { ...base.values.policies[policy.targetPrincipalId], ...policy }])) },
      }
      setBase({ values: savedValues, expectedVersion: result.membershipVersion, membershipEpoch: intent.membershipEpoch })
      if (revision.current === editedAt && (!pending || editedAt === 0)) setDraft(savedValues)
      setPending(null)
    } catch (error) {
      if (token === generation.current) { setFailure(friendly(error)); setPending(operationOutcomeUncertain(error) ? intent : null) }
    } finally { if (token === generation.current) setSaving(false) }
  }
  const values = draft ?? groupSettingsValues(member)
  const roleLabel = role => role === 'owner' ? 'Group owner' : role === 'admin' ? 'Group admin' : 'Group member'
  return h('details', { id: 'bt-comm-members', className: 'bt-comm-members', open, onKeyDown: event => { if (open && event.key === 'Escape') { event.stopPropagation(); close() } } },
    h('summary', { ref: summary, tabIndex: open ? 0 : -1, onClick: event => { event.preventDefault(); if (open) close(); else begin() } }, t('Group members and receiving rules')),
    open ? h(Fragment, null,
      h('div', { className: 'bt-comm-settings-actions' }, canManage ? h('button', { type: 'button', onClick: () => { void saveSettings() }, disabled: saving || !dirty && !pending, 'data-dirty': dirty, 'aria-label': t('Save group settings') }, t('Save')) : null,
        h('button', { type: 'button', onClick: close, 'aria-label': t('Close member settings') }, t('Close member settings'))),
      failure ? h('p', { className: 'bt-comm-error', role: 'alert' }, t(failure)) : null,
      pending ? h('p', { role: 'status' }, t('An operation is not confirmed. Check status, then retry the same action.')) : null,
      base && member.membershipVersion > base.expectedVersion ? h('p', { role: 'status' }, t('Group settings changed elsewhere. Your edits are retained. Close and reopen to review the current settings.')) : null,
      h('p', { className: 'bt-comm-reference' }, t('Roles control group management. Speaking permissions control who can send.')),
      member.ownerPrincipalId && !members.some(person => person.principalId === member.ownerPrincipalId) ? h('p', { role: 'status' }, t('The owner is unavailable. Ownership stays with that identity.')) : null,
      !member.ownerPrincipalId ? h('p', { role: 'status' }, t('This legacy group has no retained owner. No automatic takeover is allowed.')) : null,
      canManage ? h('label', { className: 'bt-comm-field' }, t('Group name'), h('input', { value: values.title, onChange: event => edit({ title: event.target.value }), 'aria-label': t('Group name') })) : null,
      members.map(person => {
        const editable = isOwner || member.role === 'admin' && person.role === 'member'
        const policy = values.policies[person.principalId] ?? { role: person.role, speakingMode: person.speakingMode }
        const changePolicy = change => edit({ policies: { ...values.policies, [person.principalId]: { ...policy, ...change } } })
        return h('div', { key: person.principalId, className: 'bt-comm-person', 'data-principal-id': person.principalId },
          h('span', { title: person.principalId }, personLabel(person)), h('span', { className: 'bt-comm-role' }, t(roleLabel(person.role))),
          editable ? h(Fragment, null,
            isOwner && person.role !== 'owner' ? h('label', null, t('Group role'), h('select', { value: policy.role, 'aria-label': t('Group role'), onChange: event => changePolicy({ role: event.target.value }) }, h('option', { value: 'member' }, t('Group member')), h('option', { value: 'admin' }, t('Group admin')))) : null,
            h('label', null, t('Speaking permission'), h('select', { value: policy.speakingMode, 'aria-label': t('Speaking permission'), onChange: event => changePolicy({ speakingMode: event.target.value }) },
              (person.kind === 'human' ? [['readOnly', 'Read only'], ['speak', 'Can speak']] : [['passive', 'Reply only'], ['active', 'Can speak']]).map(([value, label]) => h('option', { key: value, value }, t(label)))))) : h('span', null, t(['readOnly', 'passive'].includes(person.speakingMode) ? person.kind === 'human' ? 'Read only' : 'Reply only' : 'Can speak')),
          canManage && person.role !== 'owner' && (isOwner || person.role === 'member') && person.principalId !== humanId ? btn('Remove from group', () => { void act(() => operation('remove', { conversationId: member.conversationId, targetPrincipalId: person.principalId })) }) : null)
      }),
      h('p', { className: 'bt-comm-reference' }, t('Both Bot modes may @mention current group Bots in an authorized final reply. Reply-only Bots cannot initiate messages or send proactively with tools. Active Bots may also initiate with tools. Bot delegation chains stop at the server’s finite limit.')),
      canManage ? h(Fragment, null,
        chooseContact('Invite participant', invite, setInvite, contacts.filter(contact => !members.some(person => person.principalId === contact.principalId))),
        btn('Invite', () => { void act(() => operation('invite', { conversationId: member.conversationId, inviteePrincipalId: invite })) }, { disabled: busy || !invite }),
        h('label', { className: 'bt-comm-field' }, t('Receiving rule'), h('select', { value: values.routing.mode, onChange: event => edit({ routing: { mode: event.target.value, adminBotPrincipalId: event.target.value === 'admin' ? values.routing.adminBotPrincipalId : null } }), 'aria-label': t('Receiving rule') },
          h('option', { value: 'mentionsOnly' }, t('Mentions only')), h('option', { value: 'admin' }, t('Plain messages go to one Bot')))),
        values.routing.mode === 'admin' ? chooseContact('Default reply Bot', values.routing.adminBotPrincipalId ?? '', id => edit({ routing: { mode: 'admin', adminBotPrincipalId: id } }), members.filter(person => person.kind === 'bot')) : null) : h('p', null, t(member.routingMode === 'admin' ? 'Plain messages go to one Bot' : 'Mentions only')),
      isOwner ? h(Fragment, null,
        chooseContact('Transfer ownership to', newOwner, value => { setNewOwner(value); setConfirm('') }, members.filter(person => person.principalId !== humanId)),
        btn(confirm === 'transfer' ? 'Confirm ownership transfer' : 'Transfer ownership', () => { if (confirm !== 'transfer') setConfirm('transfer'); else void act(() => operation('transfer', { conversationId: member.conversationId, targetPrincipalId: newOwner, expectedVersion: member.membershipVersion })) }, { disabled: busy || !newOwner })) : null,
      btn(confirm === 'leave' ? 'Confirm leaving group' : 'Leave group', () => { if (confirm !== 'leave') setConfirm('leave'); else void act(() => operation('remove', { conversationId: member.conversationId })) }, { disabled: busy || isOwner, title: isOwner ? t('Transfer ownership before leaving') : undefined }),
      isOwner ? btn(confirm === 'dissolve' ? 'Confirm ending group for everyone' : 'End group for everyone', () => { if (confirm !== 'dissolve') setConfirm('dissolve'); else void act(() => operation('dissolve', { conversationId: member.conversationId })) }, { className: 'bt-comm-danger' }) : null) : null)
}

export function CommunicationSurface({ roster, surface, panel, request = communicationRequest }) {
  const team = useSyncExternalStore(roster.subscribe, roster.getSnapshot)
  const mode = useSyncExternalStore(surface.subscribe, surface.getSnapshot)
  const open = useSyncExternalStore(panel.subscribe, panel.getSnapshot)
  const visible = open && mode.mode === 'bot'
  const [shown, closing] = useLinger(visible, 160)
  const [receivedState, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const stateScope = `${Boolean(team.communicationEnabled)}:${team.communicationHubId ?? ''}`, currentStateScope = useRef(stateScope), stateOrder = useRef(0)
  if (currentStateScope.current !== stateScope) { currentStateScope.current = stateScope; stateOrder.current += 1 }
  const state = !team.communicationEnabled || team.communicationHubId && receivedState?.hubId !== team.communicationHubId ? null : receivedState
  const [pollError, setPollError] = useState(''), [syncError, setSyncError] = useState(null)
  const [operationPending, setOperationPending] = useState(() => readOperationIds().length > 0)
  const [attaching,setAttaching]=useState(false),attachmentFlight=useRef(false)
  const [selected, setSelected] = useState(() => read(SELECTED, null))
  const [drafts, setDrafts] = useState(() => read(DRAFTS, {})), [attempts, setAttempts] = useState(() => read(ATTEMPTS, {}))
  const [page, setPage] = useState(null), [older, setOlder] = useState(null), [reply, setReply] = useState(null)
  const [referenced, setReferenced] = useState(null), [jumpRevision, setJumpRevision] = useState(0)
  const pendingJump = useRef(null), referenceOrder = useRef(0), contextKey = useRef('')
  const [title, setTitle] = useState(''), [invitees, setInvitees] = useState([])
  const [completion, setCompletion] = useState(null), [completionIndex, setCompletionIndex] = useState(0), [composing, setComposing] = useState(false)
  const chooser = useRef(null), chooserTrigger = useRef(null), previousPanel = useRef(''), panelReturn = useRef('')
  const [browse, setBrowse] = useState(false), [activePanel, setActivePanel] = useState(''), [panelBack, setPanelBack] = useState(''), [inspectedIds, setInspectedIds] = useState([])
  const panelShown = useRef({ name: '', visible, version: 0 })
  if (panelShown.current.name !== activePanel || panelShown.current.visible !== visible) panelShown.current = { name: activePanel, visible, version: panelShown.current.version + 1 }
  const [sidebarHidden, setSidebarHidden] = useState(() => read(SIDEBAR_HIDDEN, false)), [newMenuOpen, setNewMenuOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState(''), [searchCursor, setSearchCursor] = useState(0)
  const newMenu = useRef(null), newTrigger = useRef(null)
  const newMenuShown = useRef(newMenuOpen), previousSidebar = useRef(sidebarHidden)
  newMenuShown.current = newMenuOpen
  const [threadMessageId, setThreadMessageId] = useState(null)
  const [threadReplyTarget,setThreadReplyTarget]=useState(null),[threadPosition,setThreadPosition]=useState({left:8,top:8})
  const threadAnchor=useRef(null),viewportTick=useViewport()
  const input = useRef(null), frame = useRef(null), log = useRef(null), autoScroll = useRef(true), pageOrder = useRef(0), operationIds = useRef(new Map(readOperationIds()))
  const labels = contactLabels(state?.contacts ?? [], state?.instanceId, t)
  const scope = communicationScope(state)
  syncAvatarDirectory(state?.contacts??[],state?.hubId??state?.hubUrl??'legacy')
  const member = state?.conversations?.find(item => item.conversationId === selected)
  const key = `${scope}:${selected}`
  contextKey.current = `${key}:${member?.membershipEpoch}`
  useEffect(() => { setThreadMessageId(null); setActivePanel(current => ['thread', 'participant'].includes(current) ? '' : current) }, [scope, selected, member?.membershipEpoch])
  const draft = drafts[key] ?? { text: '', mentions: [] }
  const changeDraft = value => setDrafts(current => { const next = { ...current, [key]: { ...(current[key] ?? {text:'',mentions:[]}), ...value } }; save(DRAFTS, next); return next })
  const openThread=(message,trigger)=>{
    chooserTrigger.current=trigger??document.activeElement
    threadAnchor.current=trigger?.getBoundingClientRect?.()??{left:window.innerWidth/2,top:window.innerHeight/3,bottom:window.innerHeight/3}
    setThreadMessageId(message.messageId);setThreadReplyTarget(message);setActivePanel('thread');setError('')
  }
  useLayoutEffect(()=>{
    if(activePanel!=='thread'||!chooser.current)return
    const anchor=threadAnchor.current,box=chooser.current.getBoundingClientRect()
    if(!anchor)return
    const maxTop=Math.max(8,viewBottom()-box.height-8)
    setThreadPosition({left:Math.max(8,Math.min(anchor.left,window.innerWidth-box.width-8)),top:Math.max(8,Math.min(anchor.bottom+6,maxTop))})
  },[activePanel,threadMessageId,viewportTick,member?.speakingMode])
  const close = () => { panel.set(false); save(OPEN, false) }
  const refresh = async () => {
    const order = ++stateOrder.current, scope = stateScope
    try {
      const value = await request({ endpoint: 'state' })
      if (currentStateScope.current === scope && order === stateOrder.current) { setState(value); setPollError('') }
      return value
    } catch (failure) {
      if (currentStateScope.current === scope && order === stateOrder.current) setPollError(friendly(failure))
      throw failure
    }
  }
  useEffect(() => {
    if (!team.communicationEnabled) { setState(null); setPollError(''); return undefined }
    const live = liveRefresh(refresh, { intervalMs: 750 })
    return () => { stateOrder.current += 1; live.stop() }
  }, [team.communicationEnabled, team.communicationHubId, request])
  useEffect(() => {
    if (!shown) return undefined
    const returning=Boolean(previousPanel.current&&!activePanel)
    previousPanel.current=activePanel
    const visible = node => !node.checkVisibility || node.checkVisibility()
    const controls = () => [...((activePanel ? chooser.current : frame.current)?.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary') ?? [])]
      .filter(node => visible(node) && (!node.closest('details:not([open])') || node.tagName === 'SUMMARY'))
    const focusDefault = () => (activePanel ? controls()[0] : input.current && !input.current.disabled && visible(input.current) ? input.current : controls()[0])?.focus()
    if(returning&&chooserTrigger.current?.isConnected)chooserTrigger.current.focus()
    else focusDefault()
    // A host sign-in/first-run dialog may open above this restored surface.
    // Competing focus traps must not bounce focus indefinitely between portals.
    const foreignDialog = node => !frame.current?.contains(node) && node?.closest?.('dialog,[role="dialog"],[role="alertdialog"]')
    const retain = event => { if (!foreignDialog(event.target) && !(activePanel ? chooser.current : frame.current)?.contains(event.target)) focusDefault() }
    const keys = event => {
      if (foreignDialog(event.target)) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); event.stopImmediatePropagation(); setNewMenuOpen(false); setSearchQuery(''); setSearchCursor(0); chooserTrigger.current = document.activeElement; setActivePanel('search'); return
      }
      if (newMenuShown.current && event.key === 'Tab') { setNewMenuOpen(false); return }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (newMenuShown.current) { setNewMenuOpen(false); newTrigger.current?.focus(); return }
        if (completion) { setCompletion(null); return }
        if (activePanel==='thread'&&chooser.current?.querySelector('[role=listbox]')) return
        if (activePanel) { setActivePanel(''); chooserTrigger.current?.focus(); return }
        const members = frame.current?.querySelector('.bt-comm-members[open]')
        if (members) { members.querySelector('summary')?.click(); focusDefault() } else close()
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
  }, [shown, browse, selected, member?.speakingMode, activePanel, Boolean(completion)])
  useEffect(() => {
    if (!shown || !activePanel) return
    const returning = panelReturn.current
    panelReturn.current = ''
    const target=(returning ? chooser.current?.querySelector(`[data-open-panel="${returning}"]`) : null) ?? (activePanel==='thread'?(chooser.current?.querySelector('textarea')??chooser.current?.querySelector('button')):chooser.current?.querySelector(['group','search'].includes(activePanel)?'input':'button'))
    target?.focus()
  }, [shown, activePanel])
  useEffect(() => {
    if (!shown || !newMenuOpen) return undefined
    ;(newMenu.current?.querySelector('[role="menuitem"]:not(:disabled)') ?? newTrigger.current)?.focus()
    const outside = event => { if (!newMenu.current?.contains(event.target)) setNewMenuOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [shown, newMenuOpen])
  useEffect(() => {
    if (!shown || previousSidebar.current === sidebarHidden) return
    previousSidebar.current = sidebarHidden
    frame.current?.querySelector(sidebarHidden ? '.bt-comm-expand' : '.bt-comm-collapse')?.focus()
  }, [shown, sidebarHidden])
  useEffect(() => { save(SELECTED, selected); setOlder(null); setReply(null); setReferenced(null); pendingJump.current = null; referenceOrder.current += 1; setCompletion(null); autoScroll.current = true; input.current?.focus() }, [scope, selected])
  useEffect(() => {
    if (!shown) return undefined
    const clear = () => { pendingJump.current = null; referenceOrder.current += 1; setReferenced(null) }
    document.addEventListener('pointerdown', clear, true)
    return () => document.removeEventListener('pointerdown', clear, true)
  }, [shown])
  useLayoutEffect(() => {
    const jump = pendingJump.current
    const target = jump && [...(log.current?.querySelectorAll('article') ?? [])].find(node => node.dataset.messageId === jump.messageId)
    if (target && jump.context === contextKey.current) {
      pendingJump.current = null; autoScroll.current = false
      target.scrollIntoView?.({ block: 'center' })
    } else if (!jump && log.current && older === null && autoScroll.current) log.current.scrollTop = log.current.scrollHeight
  }, [page, older, referenced, jumpRevision, state?.outbox])
  useEffect(() => {
    if (!shown || !member) { setPage(null); return undefined }
    let active = true
    const order = ++pageOrder.current
    void request({ endpoint: 'history', conversationId: selected, limit: 50, ...(older === null ? {} : { before: older }) }).then(value => {
      if (active && pageOrder.current === order) { setPage({ ...value, scope }); setSyncError(null) }
    }).catch(failure => { if (active) { setPage(null); setSyncError({ conversationId: selected, message: friendly(failure) }) } })
    return () => { active = false }
  }, [scope, shown, selected, member?.membershipEpoch, older, older === null ? member?.watermark : null, request])
  useEffect(() => {
    if (!shown || page?.scope !== scope || page?.conversationId !== selected || !page.events.length) return undefined
    let active = true
    const mark = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void request({ endpoint: 'read', conversationId: selected, seq: page.events.at(-1).conversationSeq }).catch(failure => {
        if (!active) return
        setSyncError({ conversationId: selected, message: friendly(failure) })
        if (['FORBIDDEN', 'NOT_A_MEMBER', 'MEMBERSHIP_REVOKED'].includes(failure.code)) setPage(null)
      })
    }
    mark(); window.addEventListener('focus', mark); document.addEventListener('visibilitychange', mark)
    return () => { active = false; window.removeEventListener('focus', mark); document.removeEventListener('visibilitychange', mark) }
  }, [scope, shown, selected, page, request])
  const operation = async (endpoint, values) => {
    const current = state?.conversations?.find(item => item.conversationId === values.conversationId)
    if (current && !['dm','create-group','accept'].includes(endpoint)) values = { membershipEpoch: current.membershipEpoch, expectedVersion: current.membershipVersion, ...values }
    const operationKey = JSON.stringify([scope, endpoint, values])
    if (!operationIds.current.has(operationKey)) operationIds.current.set(operationKey, randomId())
    const persist = () => { save(OPERATION_IDS, [...operationIds.current]); setOperationPending(operationIds.current.size > 0) }
    persist()
    let value
    try { value = await request({ endpoint, ...values, operationId: operationIds.current.get(operationKey) }) }
    catch (failure) {
      if (!operationOutcomeUncertain(failure)) { operationIds.current.delete(operationKey); persist() }
      throw failure
    }
    if (value.status !== 'queued') { operationIds.current.delete(operationKey); persist() }
    let refreshedState
    try { refreshedState = await refresh() } catch (failure) { setPollError(friendly(failure)) }
    return { ...value, refreshedState }
  }
  const act = async work => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (failure) { setError(friendly(failure)) } finally { setBusy(false) }
  }
  const send = () => act(async () => {
    if(attachmentFlight.current)return
    if (!member || member.kind === 'group' && member.speakingMode !== 'speak' || !draft.text.trim() && !draft.attachments?.length) return
    const intent = attempts[key] ?? { endpoint: 'send', conversationId: selected, membershipEpoch: member.membershipEpoch, messageId: randomId(), clientCreatedAt: new Date().toISOString(),
      text: draft.text, mentions: draft.mentions, ...(draft.attachments?.length ? {attachments:draft.attachments} : {}), replyToMessageId: reply?.messageId ?? null }
    const next = { ...attempts, [key]: intent }; save(ATTEMPTS, next); setAttempts(next)
    // Keep the exact intent on every failure; retry must retain the original ID.
    await request(intent)
    delete next[key]; save(ATTEMPTS, next); setAttempts({ ...next })
    changeDraft({ text: '', mentions: [], manualMentions: [], attachments:[] }); setReply(null)
    await refresh(); input.current?.focus()
  })
  const choose = id => { setSelected(id); setBrowse(false); setError('') }
  const openReference = async messageId => {
    const context = contextKey.current, order = ++referenceOrder.current
    try {
      const event = await request({ endpoint: 'reference', conversationId: selected, messageId })
      if (context !== contextKey.current || order !== referenceOrder.current) return
      autoScroll.current = false
      pendingJump.current = { messageId, context }
      setReferenced(messageId); setJumpRevision(value => value + 1)
      if (!page?.events.some(item => item.message?.messageId === messageId)) setOlder(event.conversationSeq + 24)
    } catch {
      if (context === contextKey.current && order === referenceOrder.current) setError('Earlier message unavailable')
    }
  }
  const btn = (label, onClick, props = {}) => h('button', { type: 'button', disabled: busy, onClick, ...props }, props.children ?? t(label))
  const chooseContact = (label, value, onChange, people) => h('details', { className: 'bt-comm-participant-picker' },
    h('summary', null, t(label), value ? ': ' : '', value ? personLabel(people.find(person => person.principalId === value) ?? { principalId: value }) : ''),
    contactsByAddress(people, state?.addressNotes).map(group => h('section', { key: group.address, className: 'bt-comm-address' }, h('h3', null, t(group.address), group.note ? h('span', { className: 'bt-comm-ip-note' }, t('IP note'), ': ', group.note) : null), group.instances.map(instance => h('section', { key: instance.instanceId ?? 'unknown' }, h('p', { className: 'bt-comm-reference', title: instance.instanceId }, instance.label), instance.contacts.map(person => btn(labels.get(person.principalId) ?? person.displayName, event => { onChange(person.principalId); const details = event.currentTarget.closest('details'); details.open = false; details.querySelector('summary')?.focus() }, { key: person.principalId, 'aria-pressed': person.principalId === value, children: personLabel(person) })))))))
  if (!shown) return null
  const events = page?.scope === scope && page?.conversationId === selected && page?.membershipEpoch === member?.membershipEpoch ? page.events : []
  const visibleIds = new Set(events.map(event => event.message?.messageId))
  const ownOutbox = member ? (state?.outbox ?? []).filter(item => (!item.principalId || item.principalId === state.humanPrincipalId) && item.type === 'message.publish' && item.conversationId === selected) : []
  const activityOutbox = (state?.outbox ?? []).filter(item => (!item.principalId || item.principalId === state.humanPrincipalId) && item.type === 'message.publish' && (!member || item.conversationId === selected))
  const currentMembers = member?.info?.members ?? []
  const canSpeak = member && (member.kind !== 'group' || member.speakingMode === 'speak')
  const contacts = state?.contacts ?? []
  const attach = async files => {
    const context=contextKey.current
    if(!canSpeak||!state.attachmentsAvailable||attempts[key]||busy)return
    if(attachmentFlight.current){setError('Wait for the current attachment to finish.');return}
    attachmentFlight.current=true;setAttaching(true)
    try{const attachments=await selectedAttachments([...files],draft.attachments??[]);if(context===contextKey.current)changeDraft({attachments})}
    catch(failure){if(context===contextKey.current)setError(friendly(failure))}
    finally{attachmentFlight.current=false;setAttaching(false)}
  }
  const operations = state?.outbox?.filter(item => (!item.principalId || item.principalId === state.humanPrincipalId) && item.type !== 'message.publish' && item.state !== 'accepted' && (!member || item.conversationId === selected)) ?? []
  const pendingForConversation = [...operationIds.current.keys()].some(item => { const [operationScope, , values] = JSON.parse(item); return operationScope === scope && (member ? values.conversationId === selected : !values.conversationId) })
  const remoteCount = contacts.filter(contact => contact.homeInstanceId !== state?.instanceId).length
  const inspect = ids => { const authorized = ids.filter(id => currentMembers.some(person => person.principalId === id)); if (authorized.length) { setInspectedIds(authorized); showPanel('participant') } }
  const showPanel = (name, trigger) => { setPanelBack(''); setNewMenuOpen(false); chooserTrigger.current = newMenuOpen ? newTrigger.current : trigger ?? document.activeElement; if (name === 'search') { setSearchQuery(''); setSearchCursor(0) }; setActivePanel(name) }
  const messageContact = id => {
    const context = contextKey.current, version = panelShown.current.version
    void act(async () => {
      const value = await operation('dm', { otherPrincipalId: id })
      if (value.conversationId && context === contextKey.current && panelShown.current.visible && panelShown.current.name === 'manage-contacts' && version === panelShown.current.version) {
        choose(value.conversationId); setActivePanel('')
      }
    })
  }
  const collapseSidebar = value => { setSidebarHidden(value); save(SIDEBAR_HIDDEN, value) }
  const startMenu = () => { collapseSidebar(false); setBrowse(true); setNewMenuOpen(true) }
  const connectionBlocked = state?.error && !['CONNECTION_LOST','REQUEST_TIMEOUT','STORAGE_UNAVAILABLE','BACKPRESSURE','HISTORY_GAP'].includes(state.error)
  const connectionLabel = !team.communicationEnabled ? 'Not configured' : pollError ? 'Offline' : !state ? 'Connecting…' : state.connected ? 'Connected to Hub' : connectionBlocked ? 'Offline' : 'Reconnecting to Hub'
  const roleLabel = role => role === 'owner' ? 'Group owner' : role === 'admin' ? 'Group admin' : 'Group member'
  const avatar = (id, name) => {
    const contact = contacts.find(person => person.principalId === id)
    return h(CommunicationAvatar, { person: contact ?? { principalId: id, displayName: name ?? id, kind: id?.startsWith('bot:') ? 'bot' : id?.startsWith('human:') ? 'human' : 'group' }, request, allowed: Boolean(contact) })
  }
  const identityIcons = person => {
    const kind = person.kind ?? (person.principalId?.startsWith('bot:') ? 'bot' : 'human')
    const instanceId = person.homeInstanceId ?? person.principalId?.split(':')[1]
    return h(Fragment, null,
      h('span', { className: 'bt-comm-kind-icon', 'aria-label': t(kind === 'bot' ? 'Bot' : 'Human'), title: t(kind === 'bot' ? 'Bot' : 'Human'), 'data-symbol': kind === 'bot' ? '◇' : '○' }),
      instanceId && instanceId !== state?.instanceId ? h('span', { className: 'bt-comm-kind-icon', 'aria-label': t('Remote'), title: t('Remote'), 'data-symbol': '↗' }) : null)
  }
  const personLabel = person => h('span', { className: 'bt-comm-person-label', title: `${person.displayName ?? ''} · ${person.instanceLabel ?? person.homeInstanceId ?? ''} · ${person.principalId}` }, avatar(person.principalId, person.displayName), labels.get(person.principalId) ?? person.displayName ?? person.principalId, identityIcons(person))
  const groupedContacts = render => contactsByAddress(contacts.filter(person => person.principalId !== state?.humanPrincipalId), state?.addressNotes).map(group => h('section', { key: group.address, className: 'bt-comm-address' },
    h('h3', null, t(group.address), group.note ? h('span', { className: 'bt-comm-ip-note' }, t('IP note'), ': ', group.note) : null), group.instances.map(instance => h('section', { key: instance.instanceId ?? 'unknown' }, h('p', { className: 'bt-comm-reference', title: instance.instanceId }, instance.label, ' · ', instance.instanceId), instance.contacts.map(render)))))
  const suggestions = completion ? mentionChoices(currentMembers, completion.query, t('All Bots')) : []
  const complete = person => {
    const result = insertMention(draft, completion, person)
    changeDraft({ text: result.text, mentions: result.mentions, manualMentions: result.manualMentions }); setCompletion(null)
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(result.caret, result.caret) })
  }
  const updateCompletion = node => { setCompletion(mentionQuery(node.value, node.selectionStart)); setCompletionIndex(0) }
  const wanted = searchQuery.trim().toLocaleLowerCase()
  const searchable = value => String(value ?? '').toLocaleLowerCase().includes(wanted)
  const searchResults = [
    ...(state?.conversations ?? []).filter(item => [conversationTitle(item,state.humanPrincipalId,labels),item.lastMessage?.summary,...(item.info?.members ?? []).map(person=>person.displayName)].some(searchable)).map(item => ({ id:item.conversationId, title:conversationTitle(item,state.humanPrincipalId,labels), preview:item.lastMessage?.summary ?? '', avatar:h(ConversationAvatar,{conversation:item,humanId:state.humanPrincipalId,request,size:24}), run:()=>{setActivePanel('');choose(item.conversationId)} })),
    ...contacts.filter(person=>person.principalId !== state?.humanPrincipalId && [labels.get(person.principalId),person.displayName,person.instanceLabel].some(searchable)).map(person=>({ id:person.principalId,title:labels.get(person.principalId) ?? person.displayName,preview:t('New message'),avatar:h(CommunicationAvatar,{person,request,size:24}),run:()=>{void act(async()=>{const value=await operation('dm',{otherPrincipalId:person.principalId});setActivePanel('');choose(value.conversationId)})} })),
  ].slice(0,50)
  const searchIndex = Math.max(0, Math.min(searchCursor, searchResults.length-1))

  return createPortal(h('section', { ref: frame, className: 'bt-comm-frame', style:{'--bt-tap-duration':`${SPRING_TAP.duration}ms`,'--bt-tap-easing':SPRING_TAP.easing}, role: 'dialog', 'aria-modal': true, 'data-closing': closing, 'data-collapsed': sidebarHidden, 'data-browse': browse || !member, 'data-setup': !team.communicationEnabled, 'aria-label': t('Remote communication') },
    h('aside', { id:'bt-comm-nav', className: 'bt-comm-nav' },
      h('div', { className: 'bt-comm-nav-heading' }, h('h2', {title:t('Remote communication')}, t('Remote communication')),
        h('div', { className:'bt-comm-nav-actions' },
          btn('Personal settings', event => showPanel('settings', event.currentTarget), { className: 'bt-comm-settings-icon', 'aria-label': t('Personal settings'), title: t('Personal settings'), children: h(GearIcon) }),
          btn('Contacts', event => showPanel('manage-contacts', event.currentTarget), { className: 'bt-comm-settings-icon', 'aria-label': t('Contacts'), title: t('Contacts'), disabled: busy || !team.communicationEnabled, children: h(PeopleIcon) }),
          btn('Search',event=>showPanel('search',event.currentTarget),{className:'bt-comm-settings-icon','aria-label':t('Search'),title:t('Search'),children:h(SearchIcon)}),
          h('div',{ref:newMenu,className:'bt-comm-new-menu',onKeyDown:event=>{
            if(!newMenuOpen||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
            event.preventDefault();const items=[...newMenu.current.querySelectorAll('[role="menuitem"]:not(:disabled)')],index=items.indexOf(document.activeElement)
            const next=event.key==='Home'?0:event.key==='End'?items.length-1:event.key==='ArrowDown'?(index+1)%items.length:(index-1+items.length)%items.length
            items[next]?.focus()
          }},btn('New…',()=>setNewMenuOpen(value=>!value),{ref:newTrigger,className:'bt-comm-settings-icon','aria-label':t('New…'),title:t('New…'),'aria-haspopup':'menu','aria-expanded':newMenuOpen,'aria-controls':newMenuOpen?'bt-comm-create-menu':undefined,children:h(PlusIcon),onKeyDown:event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setNewMenuOpen(true)}}}),
            newMenuOpen?h('div',{className:'bt-comm-create-menu',id:'bt-comm-create-menu',role:'menu','aria-label':t('New chat')},
              btn('New message',()=>showPanel('contacts'),{role:'menuitem',disabled:busy||!team.communicationEnabled,children:h(Fragment,null,h(ChatsIcon),t('New message'))}),
              btn('New group',()=>showPanel('group'),{role:'menuitem',disabled:busy||!team.communicationEnabled,children:h(Fragment,null,h(PeopleIcon),t('New group'))})):null),
          btn('Collapse sidebar',()=>{setNewMenuOpen(false);collapseSidebar(true)},{className:'bt-comm-settings-icon bt-comm-collapse','aria-label':t('Collapse sidebar'),'aria-controls':'bt-comm-nav','aria-expanded':true,title:t('Collapse sidebar'),children:h(SidebarIcon)}))),
      btn('Back to local chats', close, { className: 'bt-comm-back' }),
      member ? btn('Back to conversation', () => setBrowse(false), { className: 'bt-comm-mobile' }) : null,
      h('section', { className: 'bt-comm-connection', 'aria-label': t('Connection status') },
        h('p', { className: 'bt-comm-connection-label', role: 'status', 'data-connected': Boolean(state?.connected && !pollError) }, h('span', { className: 'bt-comm-dot', 'aria-hidden': true }), t(connectionLabel)),
        state ? h('p', { className: 'bt-comm-reference bt-comm-connection-details' }, `${state.instanceId} · ${t('Remote contacts')}: ${remoteCount}`) : null,
        team.communicationEnabled && !state?.connected && !connectionBlocked ? h('p', { className: 'bt-comm-reference' }, t('Queued messages send automatically when the connection returns.')) : null,
        team.communicationEnabled ? btn('Refresh status', () => { void act(refresh) }) : null,
        null),
      h('div', { className: 'bt-comm-section-title' }, t('Conversations'), h('span', null, state?.conversations?.length ?? 0)),
      h('nav', { 'aria-label': t('Communication conversations') }, (state?.conversations ?? []).map(item =>
        h(ConversationRow, { key: item.conversationId, conversation: item, humanId: state.humanPrincipalId, labels, request, selected: item.conversationId === selected, onChoose: choose, disabled: busy }))),
      !state?.conversations?.length ? h('p', { className: 'bt-comm-reference' }, t('Your cross-device conversations will appear here.')) : null,
      state?.invites?.length ? h('div', null, h('h3', null, t('Invitations')), state.invites.map(invitation => h('div', { key: invitation.inviteId },
        avatar(invitation.principalId), h('p', null, `${invitation.title} · ${labels.get(invitation.principalId) ?? invitation.principalId}`),
        btn('Accept invitation', () => { void act(() => operation('accept', { inviteId: invitation.inviteId, recipientPrincipalId: invitation.principalId })) })))) : null,
      null),
    activePanel ? h('div', { className: `bt-comm-modal-backdrop${activePanel==='thread'?' bt-comm-thread-backdrop':''}`, onMouseDown: event => { if (event.target === event.currentTarget) { setActivePanel(''); chooserTrigger.current?.focus() } } },
      h('section', { ref: chooser, className: `bt-comm-modal${activePanel==='thread'?' bt-comm-thread-popover':''}${activePanel==='manage-contacts'?' bt-comm-contacts-modal':''}`,style:activePanel==='thread'?threadPosition:undefined, role: 'dialog', 'aria-modal': true, 'aria-label': t(activePanel === 'search' ? 'Search' : activePanel === 'settings' ? 'Personal settings' : activePanel === 'thread' ? 'Message replies' : activePanel === 'activity' ? 'Activity details' : activePanel === 'participant' ? 'Participant information' : activePanel === 'manage-contacts' ? 'Manage contacts' : activePanel === 'profile' ? 'Human profile' : activePanel === 'pairing' ? 'Pairing guide' : activePanel === 'group' ? 'New group' : 'New message') },
        activePanel==='thread'?h('button',{type:'button',onClick:()=>{setActivePanel('');chooserTrigger.current?.focus()},className:'bt-comm-thread-close','aria-label':t('Close replies'),title:t('Close replies')},h(CloseIcon)):null,
        h('div', { className: activePanel === 'thread' ? 'bt-comm-thread-heading' : 'bt-comm-modal-head' },
          h('h2', null, t(activePanel === 'search' ? 'Search' : activePanel === 'settings' ? 'Personal settings' : activePanel === 'thread' ? 'Message replies' : activePanel === 'activity' ? 'Activity details' : activePanel === 'participant' ? 'Participant information' : activePanel === 'manage-contacts' ? 'Manage contacts' : activePanel === 'profile' ? 'Human profile' : activePanel === 'pairing' ? 'Pairing guide' : activePanel === 'group' ? 'New group' : 'New message')),
          activePanel !== 'thread' ? h('div', { className: 'bt-comm-modal-actions' },
            panelBack ? h('button', { type: 'button', 'aria-label': t('Back to settings'), onClick: () => { panelReturn.current = activePanel; setActivePanel(panelBack); setPanelBack('') } }, h(ChevronLeftIcon), t('Back')) : null,
            h('button', { type: 'button', 'aria-label': t('Close dialog'), onClick: () => { setActivePanel(''); setPanelBack(''); chooserTrigger.current?.focus() } }, h(CloseIcon), t('Close'))) : null),
        activePanel === 'search' ? h('div',{className:'bt-comm-search'},
          h('label',{className:'bt-comm-field'},t('Search conversations and contacts'),h('input',{value:searchQuery,role:'combobox','aria-label':t('Search conversations and contacts'),'aria-autocomplete':'list','aria-expanded':true,'aria-controls':'bt-comm-search-results','aria-activedescendant':searchResults.length?`bt-comm-search-${searchIndex}`:undefined,onChange:event=>{setSearchQuery(event.target.value);setSearchCursor(0)},onKeyDown:event=>{
            if(event.nativeEvent.isComposing)return
            if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();setSearchCursor(index=>!searchResults.length?0:event.key==='Home'?0:event.key==='End'?searchResults.length-1:(index+(event.key==='ArrowDown'?1:-1)+searchResults.length)%searchResults.length)}
            if(event.key==='Enter'&&searchResults.length){event.preventDefault();searchResults[searchIndex].run()}
          }})),h('p',{className:'bt-comm-reference'},t('Search current conversations, contacts and recent message summaries.')),
          h('div',{id:'bt-comm-search-results',role:'listbox','aria-label':t('Results')},searchResults.map((item,index)=>btn(item.title,item.run,{key:item.id,id:`bt-comm-search-${index}`,role:'option','aria-selected':index===searchIndex,children:h(Fragment,null,item.avatar,h('span',null,h('strong',null,item.title),h('small',null,item.preview)))}))),
          !searchResults.length?h('p',{role:'status'},t('No matching conversations or contacts.')):null) : activePanel === 'settings' ? h('div', { className: 'bt-comm-personal-settings' },
          state ? h('section', null, h('h3', null, t('Your profile')), h(HumanProfile, { key: `${scope}:${state.humanPrincipalId}`, human: contacts.find(person => person.principalId === state.humanPrincipalId) ?? { principalId: state.humanPrincipalId, displayName: t('You'), kind: 'human' }, request, operation }),
            h('details', null, h('summary', null, t('Device identity')), h('p', null, state.instanceId), h('code', null, state.humanPrincipalId))) : null,
          h(CommunicationMemory, { key: scope, request }),
          h('section', null, h('h3', null, t('Connection and contacts')), btn('Add a device', () => { setPanelBack('settings'); setActivePanel('pairing') }, { 'data-open-panel': 'pairing' }),
            btn('Manage contacts', () => { setPanelBack('settings'); setActivePanel('manage-contacts') }, { disabled: !team.communicationEnabled, 'data-open-panel': 'manage-contacts' }))) : activePanel === 'thread' ? member && threadMessageId ? h(Fragment,null,h(CommunicationThread, { key: `view:${contextKey.current}:${threadMessageId}`, member, messageId: threadMessageId, request, canSpeak, onInspect: inspect,
          selectedBranch:true,onReply:setThreadReplyTarget }),canSpeak?h(ThreadReplyComposer,{key:`composer:${contextKey.current}:${threadMessageId}`,storageKey:`ds-bot:communication:thread:${contextKey.current}:${threadMessageId}`,member,target:threadReplyTarget,request,onSent:refresh,attachmentsAvailable:state.attachmentsAvailable}):null) : null : activePanel === 'activity' ? h(CommunicationActivity, { state, member, events, outbox: activityOutbox, operations, operationPending: pendingForConversation, pendingAttempt: attempts[key], error, pollError: pollError || (syncError?.conversationId === selected ? syncError.message : ''), friendly, labels, busy,
          onRefresh: () => { void act(refresh) }, onRetry: () => { setActivePanel(''); void send() }, copyDisabled: Boolean(draft.text) || Boolean(attempts[key]) || !member,
          onCopy: item => { if (draft.text || attempts[key] || !member) return; changeDraft({ text: item.text, mentions: [], manualMentions: [] }); setActivePanel(''); input.current?.focus() } }) : activePanel === 'participant' ? h('div', { className: 'bt-comm-participant-information' }, currentMembers.filter(person => inspectedIds.includes(person.principalId)).map(person => h('section', { key: person.principalId }, personLabel(person), h('p', null, t(roleLabel(person.role ?? 'member'))), h('code', null, person.principalId)))) : activePanel === 'manage-contacts' ? h(ContactManager, { key: scope, request, operation, contacts, connectionKnown: state?.connected === true && !pollError, revision: `${state?.managementRevision ?? ''}:${state?.connected ?? false}`, humanPrincipalId: state?.humanPrincipalId, instanceId: state?.instanceId, addressNotes: state?.addressNotes, onSaveAddressNote: async (address, note) => { const expectedScope = state?.addressNotesScope; const result = await request({ endpoint: 'set-address-note', address, note, expectedScope }); setState(current => current?.addressNotesScope === expectedScope ? { ...current, addressNotes: result.addressNotes } : current) }, onMessage: messageContact, messageBusy: busy }) : activePanel === 'profile' ? h(HumanProfile, { key: scope, human: contacts.find(person => person.principalId === state?.humanPrincipalId) ?? { principalId: state?.humanPrincipalId ?? 'human:local', displayName: t('You'), kind: 'human' }, request, operation }) : activePanel === 'pairing' ? h(AddDevice, { request, revision: `${team.communicationEnabled}:${team.communicationHubId}:${state?.managementRevision ?? ''}:${state?.connected ?? false}`, displayName: contacts.find(person => person.principalId === state?.humanPrincipalId)?.displayName ?? t('You'), manualGuide: h(PairingGuide, { connectionLabel }) }) : h(Fragment, null,
        activePanel === 'group' ? h('label', { className: 'bt-comm-field' }, t('Group name'), h('input', { value: title, onChange: event => setTitle(event.target.value), 'aria-label': t('Group name') })) : null,
        groupedContacts(contact => activePanel === 'group' ? h('label', { key: contact.principalId, className: 'bt-comm-check' },
          h('input', { type: 'checkbox', checked: invitees.includes(contact.principalId), onChange: event => setInvitees(current => event.target.checked ? [...current, contact.principalId] : current.filter(id => id !== contact.principalId)) }), personLabel(contact)) :
          btn(labels.get(contact.principalId), () => { void act(async () => { const value = await operation('dm', { otherPrincipalId: contact.principalId }); if (value.conversationId) { choose(value.conversationId); setActivePanel('') } }) }, { key: contact.principalId, children: personLabel(contact), className: 'bt-comm-contact' })),
        !contacts.some(person => person.principalId !== state?.humanPrincipalId) ? h('p', { className: 'bt-comm-reference' }, t('Remote contacts appear after the other device connects and publishes its identities.')) : null,
        activePanel === 'group' ? btn('Create and invite', () => { void act(async () => {
          const value = await operation('create-group', { title }); if (!value.conversationId) return
          choose(value.conversationId); setTitle(''); setInvitees([]); setActivePanel('')
          const failed = []
          for (const inviteePrincipalId of invitees) { try { await operation('invite', { conversationId: value.conversationId, inviteePrincipalId }) } catch { failed.push(labels.get(inviteePrincipalId) ?? inviteePrincipalId) } }
          if (failed.length) setError(t('Group created. Some invitations were not sent. Open the member settings to invite them.') + ' ' + failed.join(', '))
        }) }, { className: 'bt-comm-primary', disabled: busy || !title.trim() }) : null),
        btn(activePanel === 'pairing' ? 'Close guide' : 'Cancel', () => { setActivePanel(''); chooserTrigger.current?.focus() }))) : null,
    error ? h('aside', { className: 'bt-comm-toast', role: 'alert' }, h('span', null, t(error)), btn('Dismiss', () => setError(''), { disabled: false, 'aria-label': t('Dismiss notification') })) : null,
    h('main', { className: 'bt-comm-main' },
      h('header', null,
        sidebarHidden ? btn('Expand sidebar',()=>{collapseSidebar(false);setBrowse(true)},{className:'bt-comm-icon-button bt-comm-expand','aria-label':t('Expand sidebar'),title:t('Expand sidebar'),children:h(SidebarIcon)}) : null,
        member ? btn('Conversations', () => {collapseSidebar(false);setBrowse(true)}, { className: 'bt-comm-mobile' }) : null,
        !team.communicationEnabled ? btn('Back to local chats', close, { className: 'bt-comm-mobile' }) : null,
        h('div', { className: 'bt-comm-heading bt-head' }, member ? btn('View conversation details', () => {
          if (member.kind === 'group') frame.current?.querySelector('.bt-comm-members>summary')?.click()
          else inspect(currentMembers.filter(person => person.principalId !== state.humanPrincipalId).map(person => person.principalId))
        }, { className: 'bt-pill bt-comm-title-pill', children: h(Fragment, null, h(ConversationAvatar, { conversation: member, humanId: state.humanPrincipalId, request, size: 24 }), h('h2', { className: 'bt-pill-name' }, conversationTitle(member, state.humanPrincipalId, labels)), h('span', { 'aria-hidden': true }, '›')) }) : h('h2', null, t('Remote communication'))),
        btn('Activity details', event => showPanel('activity', event.currentTarget), { className: 'bt-comm-icon-button', 'aria-label': t('Activity details'), title: t('Activity details'), children: h(InfoIcon) }),
        member?.kind === 'group' ? h('span', { className: 'bt-sr' }, `${currentMembers.length} ${t('Members')} · ${t(roleLabel(member.role))} · ${t(member.speakingMode === 'readOnly' ? 'Read only' : 'Can speak')}`) : null),
      !member ? h('section', { className: 'bt-comm-empty' },
        h('span', { className: 'bt-comm-empty-symbol', 'aria-hidden': true }, '↔'),
        h('h2', null, t(team.communicationEnabled ? 'Start a conversation across devices' : 'Pair this device to get started')),
        h('p', null, t(team.communicationEnabled ? 'Message a Human or Bot directly, or bring them together in a group.' : 'Ask the Hub owner to configure communication and pair this device.')),
        team.communicationEnabled ? btn('New…',startMenu,{className:'bt-comm-primary'}) : null,
        h('p', { className: 'bt-comm-reference' }, t('Local chats stay separate from communication conversations.'))) : null,
      member?.kind === 'group' ? h(GroupSettings, { key: `${scope}:${selected}:${member.membershipEpoch}`, member, contacts, labels, operation, operationPending, act, busy, humanId: state.humanPrincipalId, btn, personLabel, chooseContact,
        pendingSettings: id => [...operationIds.current.keys()].map(item => JSON.parse(item)).find(([instanceId, endpoint, values]) => instanceId === scope && endpoint === 'save-settings' && values.conversationId === id)?.[2] ?? null }) : null,
      h('div', { ref: log, className: 'bt-comm-log', role: 'log', 'aria-label': t('Communication messages'), onScroll: event => {
        const element = event.currentTarget; autoScroll.current = !referenced && !pendingJump.current && element.scrollHeight - element.scrollTop - element.clientHeight < 80
      } },
        member && events.length > 0 && events[0].conversationSeq > member.joinSeq ? btn('Load earlier messages', () => setOlder(events[0].conversationSeq - 1)) : null,
        older !== null ? btn('Show latest messages', () => setOlder(null)) : null,
        communicationLogEvents(events).map(event => event.type === 'bot.work.started' ? h(BotWorkStarted, { key: event.eventId, event, members: currentMembers, request, onInspect: inspect }) : h('article', { key: event.message.messageId, 'data-message-id': event.message.messageId, 'data-self': event.message.author.principalId === state.humanPrincipalId, 'data-referenced': event.message.messageId === referenced },
          avatar(event.message.author.principalId, contacts.find(person => person.principalId === event.message.author.principalId)?.displayName ?? event.message.author.displayName), h('strong', { title: event.message.author.principalId }, labels.get(event.message.author.principalId) ?? event.message.author.displayName ?? (event.message.author.principalId === state.humanPrincipalId ? t('You') : event.message.author.principalId), identityIcons(contacts.find(person => person.principalId === event.message.author.principalId) ?? event.message.author)),
          h('div', { className: 'bt-comm-message-bubble' }, event.message.replyToMessageId ? h(ReferenceQuote, { key: `${scope}:${selected}:${member.membershipEpoch}:${event.message.replyToMessageId}`, conversationId: selected,
            membershipEpoch: member.membershipEpoch, messageId: event.message.replyToMessageId, request, labels, onJump: openReference }) : null,
          h('div', { className: 'bt-comm-body' }, h(CommunicationMessage, { message: event.message, members: currentMembers, request, onInspect: inspect }))),
          h(CommunicationMessageActions,{message:event.message,onReply:canSpeak?openThread:undefined,
            onThread:member.kind==='group'?openThread:undefined},
            h('time', { title: new Date(event.serverAcceptedAt).toLocaleString() }, new Date(event.serverAcceptedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))))),
        ownOutbox.filter(item => item.state !== 'failed' && !visibleIds.has(item.id) && (item.state !== 'accepted' || older === null && item.result?.conversationSeq > (page?.watermark ?? 0))).map(item => h('article', { key: item.id, 'data-message-id': item.id, 'data-self': true, 'data-failed': item.state === 'failed' },
          avatar(state.humanPrincipalId, contacts.find(person => person.principalId === state.humanPrincipalId)?.displayName), h('strong', { title: state.humanPrincipalId }, contacts.find(person => person.principalId === state.humanPrincipalId)?.displayName ?? t('You'), identityIcons({ principalId: state.humanPrincipalId, kind: 'human', homeInstanceId: state.instanceId })), h('p', { className: 'bt-comm-pending-text' }, item.text), h('p', { role: 'status' }, t(item.state === 'accepted' ? 'Hub accepted' : 'Queued on this device'))))),
      canSpeak ? h('footer', null,
        reply ? h('div', { className: 'bt-comm-reference' }, `${t('Reply to')} ${reply.content.text.slice(0,120)}`, btn('Cancel reply', () => setReply(null))) : null,
        h('div', { className: 'bt-comm-mentions' }, (draft.mentions ?? []).map(id => btn(`@${labels.get(id) ?? id} ×`, () => changeDraft({ mentions: draft.mentions.filter(item => item !== id), manualMentions: (draft.manualMentions ?? []).filter(item => item !== id) }), { key: id, 'data-manual-mention': (draft.manualMentions ?? []).includes(id), 'aria-label': `${t('Remove mention')}: ${labels.get(id) ?? id}` }))),
        suggestions.length ? h('div', { className: 'bt-comm-completion', role: 'listbox', id: 'bt-comm-completion', 'aria-label': t('Mention participant') }, suggestions.map((person, index) =>
          h('button', { type: 'button', key: person.principalId, id: `bt-comm-option-${index}`, role: 'option', 'aria-selected': completionIndex === index,
            onMouseDown: event => event.preventDefault(), onClick: () => complete(person) }, person.all ? h('span', null, avatar('@all', 'All'), t('All Bots')) : personLabel(person)))) : null,
        h('label', { className: 'bt-comm-field bt-comm-compose-field' }, h('span', { className: 'bt-sr' }, t('Communication message')), h('textarea', { ref: input, value: draft.text, rows: 2, placeholder: t('Message {name}', { name: conversationTitle(member, state.humanPrincipalId, labels) }), disabled: !canSpeak || Boolean(attempts[key]),
          onChange: event => { changeDraft({ text: event.target.value, mentions: retainedMentions(event.target.value, draft.mentions, currentMembers, draft.manualMentions) }); if (!composing) updateCompletion(event.target) },
          onClick: event => updateCompletion(event.target), onCompositionStart: () => { setComposing(true); setCompletion(null) },
          onCompositionEnd: event => { setComposing(false); updateCompletion(event.target) },
          role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': suggestions.length > 0, 'aria-controls': 'bt-comm-completion',
          'aria-activedescendant': suggestions.length ? `bt-comm-option-${completionIndex}` : undefined,
          onKeyDown: event => {
            event.stopPropagation()
            if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return
            if (suggestions.length) {
              if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setCompletionIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return }
              if (event.key === 'Escape') { event.preventDefault(); setCompletion(null); return }
              if (['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); complete(suggestions[Math.min(completionIndex, suggestions.length - 1)]); return }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() }
          }, onPaste: event => { if (event.clipboardData?.files.length) { event.preventDefault(); event.stopPropagation(); if(state.attachmentsAvailable)void attach(event.clipboardData.files);else setError('Attachments require a compatible Hub and clients.') } },
          onDragOver:event=>{event.preventDefault();event.stopPropagation()},onDrop: event => { event.preventDefault();event.stopPropagation(); if(state.attachmentsAvailable)void attach(event.dataTransfer.files);else setError('Attachments require a compatible Hub and clients.') }, 'aria-label': t('Communication message') })),
        state.attachmentsAvailable ? h('label',{className:'bt-comm-attach-picker',title:t('Attach images or files (64 KiB total)')},h(PlusIcon),h('span',{className:'bt-sr'},t('Attach images or files (64 KiB total)')),h('input',{type:'file',multiple:true,disabled:busy||attaching||Boolean(attempts[key]),'aria-label':t('Attach images or files (64 KiB total)'),onChange:event=>{void attach(event.target.files);event.target.value=''}})) : null,
        draft.attachments?.length ? h('div',{className:'bt-comm-attachment-drafts'},draft.attachments.map((file,index)=>h('span',{key:index},file.name,h('button',{type:'button',disabled:busy||attaching||Boolean(attempts[key]),'aria-label':t('Remove {name}',{name:file.name}),onClick:()=>changeDraft({attachments:draft.attachments.filter((_,i)=>i!==index)})},h(CloseIcon))))) : null,
        btn(attempts[key] ? 'Retry same send' : 'Send message', () => { void send() }, { className: 'bt-comm-send', 'aria-label': t(attempts[key] ? 'Retry same send' : 'Send message'), title: t('Enter to send · Shift+Enter for a new line'), children: h(Fragment, null, h(ArrowUpIcon), h('span', { className: 'bt-sr' }, t(attempts[key] ? 'Retry same send' : 'Send message'))), disabled: busy || attaching || !canSpeak || !draft.text.trim() && !draft.attachments?.length }),
        h('span', { className: 'bt-sr' }, t('Enter to send · Shift+Enter for a new line')),
        null) : null)), document.body)
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
