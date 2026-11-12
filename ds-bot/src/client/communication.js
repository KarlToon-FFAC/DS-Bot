import { useActionMenu } from './action-menu.js'
import {GroupProfileDialog} from './communication-group-profile.js'
import {CommunicationPresence,BotAvailabilityNotice} from './communication-presence.js'
import {MentionPerson} from './communication-mention-person.js'
import {CommunicationActivation} from './communication-activation.js'
import {RecipientPreview} from './communication-recipient-preview.js'
import {GroupInviteDialog} from './communication-invite.js'
import {ReceivingBotsDialog} from './communication-receivers.js'
import {CommunicationHistorySearch} from './communication-history-search.js'
import {useCommunicationHistory} from './communication-history.js'
import {CommunicationResizeHandle,useCommunicationWidths} from './communication-resize.js'
import { remoteHubVisible } from '../shared/remote-hub.js'
import { communicationCompatibility, incompatibleCommunication, displayCommunicationVersion, communicationReleaseRelation } from '../shared/communication-version.js'
import { useMentionDismiss } from './communication-mentions.js'
import { CommunicationActionDialog } from './communication-dialog.js'
import { ParticipantInformation } from './communication-participant.js'
import { GroupBotChoices, InvitationDetails, invitationGroups, rankedMemberContacts } from './communication-group.js'
import { communicationBrowserResetPending, prepareCommunicationBrowserEpoch, readCommunicationBrowserState, saveCommunicationBrowserState } from './communication-reset.js'
import { randomId } from './random-id.js'
import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState, useMemo, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { createSource } from './sources.js'
import { t } from './i18n.js'
import { useLinger, useViewport, viewBottom, SPRING_TAP } from './motion.js'
import { contactLabels, conversationTitle, contactsByAddress, mentionQuery, mentionChoices, insertMention, retainedMentions, groupSettingsValues, groupSettingsChanges, referenceExcerpt, communicationLogEvents, communicationScope } from './communication-model.js'
import { AddDevice, ContactManager, OwnRemoteProfile } from './communication-onboarding.js'
import { CommunicationAvatar, HumanProfile, syncAvatarDirectory } from './communication-profile.js'
import { CommunicationMessage, BotWorkStatus } from './communication-message.js'
import { selectedAttachments } from './communication-attachments.js'
import { ConversationRow, ConversationAvatar } from './communication-list.js'
import { CommunicationWorkApprovals } from './communication-work-approvals.js'
import { CommunicationActivity } from './communication-activity.js'
import { CommunicationThread, ThreadReplyComposer } from './communication-thread.js'
import { CommunicationMemory } from './communication-memory.js'
import { CommunicationMessageActions } from './communication-message-actions.js'
import { ArchiveIcon, GearIcon, ArrowUpIcon, CloseIcon, InfoIcon, PeopleIcon, ChatsIcon, SearchIcon, PlusIcon, SidebarIcon, ChevronLeftIcon } from './icons.js'
import { communicationCSS } from './communication-styles.js'
import { communicationDirectoryCSS } from './communication-directory-styles.js'
import { communicationFailure as friendly, operationOutcomeUncertain } from './communication-errors.js'
import { liveRefresh } from './communication-live.js'

const OPEN = 'ds-bot:communication:open', SELECTED = 'ds-bot:communication:selected'
const SIDEBAR_HIDDEN = 'ds-bot:communication:sidebar-hidden'
const OPERATION_IDS = 'ds-bot:communication:operation-ids'
const DRAFTS = 'ds-bot:communication:drafts', ATTEMPTS = 'ds-bot:communication:attempts'
const read = (key, fallback) => { try { return JSON.parse(readCommunicationBrowserState(sessionStorage, key)) ?? fallback } catch { return fallback } }
const save = (key, value) => { try { saveCommunicationBrowserState(sessionStorage, key, value) } catch { /* A full browser store must not prevent sending. */ } }
const readOperationIds = () => {
  const entries = read(OPERATION_IDS, [])
  const current = entries.filter(([key]) => { try { return JSON.parse(key)?.[1] !== 'reclaim' } catch { return true } })
  if (current.length !== entries.length) save(OPERATION_IDS, current)
  return current
}
export async function communicationRequest(body) {
  if (communicationBrowserResetPending()) throw Object.assign(new Error('COMMUNICATION_BROWSER_RESET_REQUIRED'), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' })
  const preflight = await fetch('/api/communication', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'reset-status' }), signal: AbortSignal.timeout(15000) })
  if ([401,403].includes(preflight.status)) throw Object.assign(new Error('INSTANCE_AUTHENTICATION_REQUIRED'), { code: 'INSTANCE_AUTHENTICATION_REQUIRED' })
  const status = await preflight.json()
  if (communicationBrowserResetPending()) throw Object.assign(new Error('COMMUNICATION_BROWSER_RESET_REQUIRED'), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' })
  if (!status.ok) throw Object.assign(new Error('COMMUNICATION_UNAVAILABLE'), { code: 'COMMUNICATION_UNAVAILABLE' })
  if (status.value.pending) throw Object.assign(new Error('COMMUNICATION_RESET_INCOMPLETE'), { code: 'COMMUNICATION_RESET_INCOMPLETE' })
  if (status.value.browserEpoch) {
    try {
      if (prepareCommunicationBrowserEpoch(status.value.browserEpoch, sessionStorage, localStorage)) {
        window.location.reload()
        throw Object.assign(new Error('COMMUNICATION_BROWSER_RESET_REQUIRED'), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' })
      }
    } catch (error) { throw Object.assign(new Error('COMMUNICATION_BROWSER_RESET_REQUIRED', { cause: error }), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' }) }
  }
  if (communicationBrowserResetPending()) throw Object.assign(new Error('COMMUNICATION_BROWSER_RESET_REQUIRED'), { code: 'COMMUNICATION_BROWSER_RESET_REQUIRED' })
  if (body.endpoint === 'reset-status') return status.value
  const response = await fetch('/api/communication', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsbot-browser-epoch': status.value.browserEpoch ?? '' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  if ([401,403].includes(response.status)) throw Object.assign(new Error('INSTANCE_AUTHENTICATION_REQUIRED'), { code: 'INSTANCE_AUTHENTICATION_REQUIRED' })
  const result = await response.json()
  if (!result.ok) throw Object.assign(new Error(result.error?.code ?? 'COMMUNICATION_UNAVAILABLE'), { code: result.error?.code, phase: result.error?.phase })
  return result.value
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

function GroupSettings({ member, contacts, operation, pendingSettings, pendingInvites, operationPending, busy, humanId, btn, personLabel, chooseContact, request, onInspect, columnWidth, onColumnWidth, multipleAvailable, groupProfilesAvailable }) {
  const context = useActionMenu()
  const [open, setOpen] = useState(false), [base, setBase] = useState(null), [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState(''), [pending, setPending] = useState(null)
  const [newOwner, setNewOwner] = useState(''), [action, setAction] = useState(null)
  const [membersExpanded, setMembersExpanded] = useState(true)
  const generation = useRef(0), revision = useRef(0), summary = useRef(null)
  useEffect(() => () => { generation.current += 1 }, [])
  useEffect(() => { if (pending && !pendingSettings(member.conversationId)) setPending(null) }, [operationPending, member.membershipVersion])
  const isOwner = member.role === 'owner', canManage = ['owner', 'admin'].includes(member.role)
  const members = member.info?.members ?? []
  const close = () => { generation.current += 1; setOpen(false); setAction(null); setBase(null); setDraft(null); setFailure(''); setSaving(false); setPending(null); summary.current?.closest('main')?.querySelector('.bt-comm-title-pill')?.focus() }
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
  const receivingIds = values.routing.defaultBotPrincipalIds
  const invalidRouting = values.routing.mode === 'admin' && !receivingIds.length
  const roleLabel = role => role === 'owner' ? 'Group owner' : role === 'admin' ? 'Group admin' : 'Group member'
  const memberRow = person => {
        const editable = isOwner || member.role === 'admin' && person.role === 'member'
        const policy = values.policies[person.principalId] ?? { role: person.role, speakingMode: person.speakingMode }
        const changePolicy = change => edit({ policies: { ...values.policies, [person.principalId]: { ...policy, ...change } } })
    return h('div', {key:person.principalId,className:'bt-comm-member-row','data-principal-id':person.principalId,onContextMenu:event=>context.open(event,[{label:t('View participant profile'),run:anchor=>onInspect([person.principalId],anchor)},{label:t('Copy identity'),run:()=>navigator.clipboard.writeText(person.principalId)},canManage&&groupProfilesAvailable&&{label:t('Edit group identity'),disabled:busy||saving,run:()=>setAction({kind:'identity',target:person})},canManage&&person.role!=='owner'&&(isOwner||person.role==='member')&&person.principalId!==humanId&&{label:t('Remove from group'),danger:true,disabled:busy||saving,run:()=>setAction({kind:'remove',target:person})}])},
      h('span',{className:'bt-comm-member-name',title:person.displayName},personLabel(person,true),h(BotAvailabilityNotice,{person}),person.groupIdentity?h('small',{className:'bt-comm-reference',title:person.groupIdentity},' · '+[...person.groupIdentity].slice(0,24).join('')+(person.groupIdentity.length>24?'…':'')):null),
      h('div',{className:'bt-comm-member-actions'},
        editable && isOwner && person.role!=='owner' ? h('select',{'aria-label':t('Group role'),title:t('Group role'),value:policy.role,onChange:event=>changePolicy({role:event.target.value})},h('option',{value:'member'},t('Member')),h('option',{value:'admin'},t('Admin'))) : h('span',{className:'bt-comm-role'},t(roleLabel(person.role))),
        editable ? h('select',{'aria-label':t('Speaking permission'),title:t('Speaking permission'),value:policy.speakingMode,onChange:event=>changePolicy({speakingMode:event.target.value})},
          (person.kind==='human'?[['readOnly','Read only'],['speak','Can speak']]:[['passive','Reply only'],['active','Can speak']]).map(([value,label])=>h('option',{key:value,value},t(label)))) : h('span',{className:'bt-comm-role'},t(['readOnly','passive'].includes(person.speakingMode)?person.kind==='human'?'Read only':'Reply only':'Can speak')),
        canManage && person.role!=='owner' && (isOwner || person.role==='member') && person.principalId!==humanId ? btn('Remove from group',()=>setAction({kind:'remove',target:person}),{className:'bt-comm-member-icon bt-comm-danger',title:t('Remove from group'),children:h(CloseIcon)}) : null,
        canManage&&groupProfilesAvailable?btn('Edit group identity',()=>setAction({kind:'identity',target:person}),{disabled:busy||saving,className:'bt-comm-member-icon',title:t('Edit group identity'),children:'✎'}):null,
        btn('View participant profile',event=>onInspect([person.principalId],event.currentTarget),{className:'bt-comm-member-icon',title:t('View participant profile'),children:'›'})))
  }
  const settingsActions = h('div', {className:'bt-comm-operation-buttons'},canManage?btn('Invite participant',()=>setAction({kind:'invite'}),{disabled:busy||saving}):null,
    canManage?h('button',{type:'button',onClick:()=>{void saveSettings()},disabled:saving||!dirty&&!pending||invalidRouting&&!pending,'data-dirty':dirty,'aria-label':t('Save group settings')},t('Save')):null,
    h('button',{type:'button',onClick:close,'aria-label':t('Close member settings')},t('Close')))
  return h('details', { id: 'bt-comm-members', className: 'bt-comm-members', open },context.menu,
    h('summary', { ref: summary, tabIndex: open ? 0 : -1, onClick: event => { event.preventDefault(); if (open) close(); else begin() } }, t('Group members and receiving rules')),
    open ? h(CommunicationResizeHandle,{side:'right',width:columnWidth,onChange:onColumnWidth}) : null,
    open ? h('section',{className:'bt-comm-members-panel',role:'complementary','aria-label':t('Group members and receiving rules')},
      h('header',{className:'bt-comm-members-heading'},h('h2',null,t('Group members and receiving rules')),h('button',{type:'button',onClick:close,'aria-label':t('Close member settings')},h(CloseIcon))),
      h('div',{className:'bt-comm-members-body'},
      failure ? h('p', { className: 'bt-comm-error', role: 'alert' }, t(failure)) : null,
      pending ? h('p', { role: 'status' }, t('An operation is not confirmed. Check status, then retry the same action.')) : null,
      base && member.membershipVersion > base.expectedVersion ? h('p', { role: 'status' }, t('Group settings changed elsewhere. Your edits are retained. Close and reopen to review the current settings.')) : null,
      canManage&&groupProfilesAvailable?btn('Change group avatar',()=>setAction({kind:'avatar'}),{disabled:busy||saving}):null,
      h('p', { className: 'bt-comm-reference' }, t('Roles control group management. Speaking permissions control who can send.')),
      member.ownerPrincipalId && !members.some(person => person.principalId === member.ownerPrincipalId) ? h('p', { role: 'status' }, t('The owner is unavailable. Ownership stays with that identity.')) : null,
      !member.ownerPrincipalId ? h('p', { role: 'status' }, t('This legacy group has no retained owner. No automatic takeover is allowed.')) : null,
      canManage ? h('label', { className: 'bt-comm-field' }, t('Group name'), h('input', { value: values.title, onChange: event => edit({ title: event.target.value }), 'aria-label': t('Group name') })) : null,
      h('details',{className:'bt-comm-member-section',open:membersExpanded},
      h('summary',{onClick:event=>{event.preventDefault();setMembersExpanded(value=>!value)}},t('Group members'),' · ',members.length),
      h('div',{className:'bt-comm-member-groups'},rankedMemberContacts(members,contacts).map((group,index)=>h('section',{key:group.person?.principalId ?? index,className:'bt-comm-member-contact','data-member-contact':group.person?.principalId ?? 'unavailable'},
        group.person ? memberRow(group.person) : h('p',{className:'bt-comm-reference'},t('Owner information unavailable')),
        group.bots.length ? h('div',{className:'bt-comm-member-bots'},group.bots.map(memberRow)) : null)))),
      member.info?.formerMembers?.length ? h('details', null, h('summary', null, t('Former Bots')), member.info.formerMembers.map(person => btn(person.displayName, event => onInspect([person.principalId], event.currentTarget), { key: person.principalId, children: personLabel(person) }))) : null,
      h('p', { className: 'bt-comm-reference' }, t('Both Bot modes can explicitly reply to their current input or finish without a reply. Final prose stays local. Reply-only Bots cannot initiate messages. Active Bots may also initiate with tools. Explicit follow-ups stay within the server’s finite delegation limit.')),
      canManage ? h(Fragment, null,
        h('label', { className: 'bt-comm-field' }, t('Receiving rule'), h('select', { value: values.routing.mode, onChange: event => edit({ routing: { mode: event.target.value, defaultBotPrincipalIds: event.target.value === 'admin' ? receivingIds : [] } }), 'aria-label': t('Receiving rule') },
          h('option', { value: 'mentionsOnly' }, t('Mentions only')), h('option', { value: 'admin' }, t('Plain messages go to selected Bots')))),
        values.routing.mode === 'admin' ? btn('Choose receiving Bots',()=>setAction({kind:'receivers'}),{disabled:busy||saving}) : null,
        invalidRouting ? h('p',{role:'status'},t('Choose at least one receiving Bot before saving.')) : null) : h('p', null, t(member.routingMode === 'admin' ? 'Plain messages go to selected Bots' : 'Mentions only')),
      values.routing.mode === 'admin' && receivingIds.length ? h('p',{className:'bt-comm-reference','aria-label':t('Default receiving Bots')},receivingIds.map(id=>members.find(person=>person.principalId===id)?.displayName ?? id).join(', ')) : null,
      isOwner ? btn('Transfer ownership', () => { setNewOwner(''); setAction({ kind: 'transfer' }) }, {disabled:busy}) : null,
      btn('Leave group', () => setAction({kind:'leave'}), { disabled: busy || isOwner, title: isOwner ? t('Transfer ownership before leaving') : undefined }),
      isOwner ? btn('End group for everyone', () => setAction({kind:'dissolve'}), {className:'bt-comm-danger',disabled:busy}) : null,
      ['avatar','identity'].includes(action?.kind)?h(GroupProfileDialog,{key:action.kind+(action.target?.principalId??''),kind:action.kind,person:action.target,member,operation,request,onClose:result=>{setAction(null);if(result?.membershipVersion)setBase(current=>current?{...current,expectedVersion:result.membershipVersion}:current)}}):null,
      h(GroupInviteDialog,{open:action?.kind==='invite',onClose:()=>setAction(null),member,contacts,humanId,request,operation,pendingInvites,busy}),
      h(ReceivingBotsDialog,{open:action?.kind==='receivers',onClose:()=>setAction(null),members,contacts,selected:receivingIds,request,multipleAvailable,onConfirm:ids=>edit({routing:{mode:'admin',defaultBotPrincipalIds:ids}})}),
      h(CommunicationActionDialog, { open: Boolean(action)&&!['invite','receivers','avatar','identity'].includes(action.kind),
        title: action?.kind === 'transfer' ? 'Transfer ownership' : action?.kind === 'remove' ? 'Remove from group' : action?.kind === 'leave' ? 'Leave group' : 'End group for everyone',
        onClose: () => setAction(null), danger: action?.kind!=='transfer',
        disabled: busy || action?.kind === 'transfer' && !newOwner,
        confirmLabel: action?.kind === 'transfer' ? 'Confirm ownership transfer' : action?.kind === 'leave' ? 'Confirm leaving group' : action?.kind === 'remove' ? 'Confirm member removal' : 'Confirm ending group for everyone',
        onConfirm: () => operation(action.kind === 'transfer' ? 'transfer' : action.kind === 'dissolve' ? 'dissolve' : 'remove', {
          conversationId: member.conversationId, membershipEpoch: member.membershipEpoch, expectedVersion: member.membershipVersion,
          ...(action.kind === 'transfer' ? {targetPrincipalId:newOwner} : action.kind === 'remove' ? {targetPrincipalId:action.target.principalId} : {}) }) },
        h('p', null, member.title),
        action?.kind === 'transfer' ? chooseContact('Transfer ownership to', newOwner, setNewOwner, members.filter(person => person.principalId !== humanId)) : null,
        action?.kind === 'transfer' ? h('p', null, t('The selected member will become the group owner.')) : null,
        action?.kind === 'remove' ? h('p', null, personLabel(action.target), ' · ', t('Removing a contact also removes their Bots from this group.')) : null,
        action?.kind === 'leave' ? h('p', null, t('You and your Bots will leave this group.')) : null,
        action?.kind === 'dissolve' ? h('p', null, t('This ends the group for every member.')) : null)), h('footer',{className:'bt-comm-members-footer'},settingsActions)) : null)
}

export function CommunicationSurface({ roster, surface, panel, request = communicationRequest }) {
  const team = useSyncExternalStore(roster.subscribe, roster.getSnapshot)
  const mode = useSyncExternalStore(surface.subscribe, surface.getSnapshot)
  const open = useSyncExternalStore(panel.subscribe, panel.getSnapshot)
  const featureEnabled = remoteHubVisible(team)
  const visible = open && mode.mode === 'bot' && featureEnabled
  const [shown, closing] = useLinger(visible, 160)
  const [columnWidths,changeColumnWidth]=useCommunicationWidths()
  const [receivedState, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const stateScope = `${featureEnabled}:${Boolean(team.communicationEnabled)}:${team.communicationHubId ?? ''}`, currentStateScope = useRef(stateScope), stateOrder = useRef(0)
  if (currentStateScope.current !== stateScope) { currentStateScope.current = stateScope; stateOrder.current += 1 }
  const state = !team.communicationEnabled || team.communicationHubId && receivedState?.hubId !== team.communicationHubId ? null : receivedState
  const [pollError, setPollError] = useState(''), [syncError, setSyncError] = useState(null)
  const [contactRequests, setContactRequests] = useState(null)
  useEffect(() => { if (request === communicationRequest) void request({ endpoint: 'reset-status' }).catch(error => setPollError(friendly(error))) }, [request])
  const [operationPending, setOperationPending] = useState(() => readOperationIds().length > 0)
  const [attaching,setAttaching]=useState(false),attachmentFlight=useRef(false)
  const [selected, setSelected] = useState(() => read(SELECTED, null))
  const [drafts, setDrafts] = useState(() => read(DRAFTS, {})), [attempts, setAttempts] = useState(() => read(ATTEMPTS, {}))
  const [reply, setReply] = useState(null)
  const [referenced, setReferenced] = useState(null), [jumpRevision, setJumpRevision] = useState(0)
  const pendingJump = useRef(null), referenceOrder = useRef(0), contextKey = useRef('')
  const [title, setTitle] = useState(''), [invitees, setInvitees] = useState([]), [invitationKey, setInvitationKey] = useState(null)
  const completionVisible = useRef(false)
  const [completion, setCompletion] = useState(null), [completionIndex, setCompletionIndex] = useState(0), [composing, setComposing] = useState(false)
  completionVisible.current = Boolean(completion)
  const chooser = useRef(null), chooserTrigger = useRef(null), previousPanel = useRef(''), panelReturn = useRef('')
  const [browse, setBrowse] = useState(false), [activePanel, setActivePanel] = useState(''), [panelBack, setPanelBack] = useState(''), [inspectedIds, setInspectedIds] = useState([])
  const panelShown = useRef({ name: '', visible, version: 0 })
  if (panelShown.current.name !== activePanel || panelShown.current.visible !== visible) panelShown.current = { name: activePanel, visible, version: panelShown.current.version + 1 }
  const [sidebarHidden, setSidebarHidden] = useState(() => read(SIDEBAR_HIDDEN, false)), [newMenuOpen, setNewMenuOpen] = useState(false)
  const [historySearchScope,setHistorySearchScope]=useState(''), searchJump=useRef(null)
  const [searchQuery, setSearchQuery] = useState(''), [searchCursor, setSearchCursor] = useState(0)
  const newMenu = useRef(null), newTrigger = useRef(null)
  const newMenuShown = useRef(newMenuOpen), previousSidebar = useRef(sidebarHidden)
  newMenuShown.current = newMenuOpen
  const [threadMessageId, setThreadMessageId] = useState(null)
  const [threadReplyTarget,setThreadReplyTarget]=useState(null),[threadPosition,setThreadPosition]=useState({left:8,top:8})
  const threadAnchor=useRef(null),viewportTick=useViewport()
  const input = useRef(null), frame = useRef(null), log = useRef(null), autoScroll = useRef(true), operationIds = useRef(new Map(readOperationIds()))
  useMentionDismiss(input, Boolean(completion), () => setCompletion(null))
  const labels = contactLabels(state?.contacts ?? [], state?.instanceId, t)
  const scope = communicationScope(state)
  const allConversations = [...(state?.conversations ?? []), ...(state?.botConversations ?? [])]
  syncAvatarDirectory([...allConversations.filter(item=>item.kind==='group').map(item=>({principalId:'group:'+item.conversationId,avatar:item.info?.avatar})),...allConversations.flatMap(item=>[...(item.info?.members??[]),...(item.info?.formerMembers??[])]),...(state?.contacts??[])],state?.hubId??state?.hubUrl??'legacy')
  const archivedIds = new Set(state?.archivedConversationIds ?? [])
  const visibleConversations = (state?.conversations ?? []).filter(item => !archivedIds.has(item.conversationId))
  const visibleBotConversations = (state?.botConversations ?? []).filter(item => !archivedIds.has(item.conversationId))
  const archivedConversations = allConversations.filter(item => item.kind === 'dm' && archivedIds.has(item.conversationId))
  const member = allConversations.find(item => item.conversationId === selected)
  const conversationRequest = useMemo(() => body => request(member?.archive && ['history','reference','read'].includes(body.endpoint) ? { ...body, endpoint: `bot-dm-${body.endpoint}`, localBotId: member.viewerBotId, membershipEpoch: member.membershipEpoch } : body), [request, member?.archive, member?.viewerBotId, member?.membershipEpoch])
  const history=useCommunicationHistory({scope,member,visible,request:conversationRequest,log,autoScroll,onError:failure=>setSyncError({conversationId:selected,message:friendly(failure)}),onLoaded:()=>setSyncError(null)})
  const page=history.page,older=page?.hasLater?true:null
  for (const person of allConversations.flatMap(item => [...(item.info?.members ?? []), ...(item.info?.formerMembers ?? [])])) {
    if (!labels.has(person.principalId)) labels.set(person.principalId, person.displayName)
    if (person.retired) labels.set(person.principalId, `${person.displayName} · ${t('Bot no longer exists')}`)
  }
  const key = `${scope}:${selected}`
  contextKey.current = `${key}:${member?.membershipEpoch}`
  useEffect(() => { setThreadMessageId(null); setActivePanel(current => ['thread', 'participant'].includes(current) ? '' : current) }, [scope, selected, member?.membershipEpoch])
  const draft = drafts[key] ?? { text: '', mentions: [] }
  const changeDraft = value => setDrafts(current => { const next = { ...current, [key]: { ...(current[key] ?? {text:'',mentions:[]}), ...value } }; save(DRAFTS, next); return next })
  const openThread=(message,trigger,reply=true)=>{
    chooserTrigger.current=trigger??document.activeElement
    threadAnchor.current=trigger?.getBoundingClientRect?.()??{left:window.innerWidth/2,top:window.innerHeight/3,bottom:window.innerHeight/3}
    setThreadMessageId(message.messageId);setThreadReplyTarget(reply?message:null);setActivePanel('thread');setError('')
  }
  useLayoutEffect(()=>{
    if(activePanel!=='thread'||!chooser.current)return
    const anchor=threadAnchor.current,box=chooser.current.getBoundingClientRect()
    if(!anchor)return
    const maxTop=Math.max(8,viewBottom()-box.height-8)
    setThreadPosition({left:Math.max(8,Math.min(anchor.left,window.innerWidth-box.width-8)),top:Math.max(8,Math.min(anchor.bottom+6,maxTop))})
  },[activePanel,threadMessageId,viewportTick,member?.speakingMode])
  const shownRightWidth=Math.min(columnWidths.right,window.innerWidth>=1280?Math.max(320,window.innerWidth-(sidebarHidden?0:Math.min(columnWidths.left,window.innerWidth-420))-420):800)
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
    if (!featureEnabled || !team.communicationEnabled) { setState(null); setPollError(''); return undefined }
    const live = liveRefresh(refresh, { intervalMs: 750 })
    return () => { stateOrder.current += 1; live.stop() }
  }, [featureEnabled, team.communicationEnabled, team.communicationHubId, request])
  useEffect(() => { if (!featureEnabled) { panel.set(false); save(OPEN,false) } }, [featureEnabled])
  useEffect(() => {
    if (!state?.connected || !state.humanPrincipalId) { setContactRequests(null); return undefined }
    let current = true
    const live = liveRefresh(async () => {
      const requests = await request({ endpoint: 'contact-requests' })
      if (current) setContactRequests({ scope, requests: Array.isArray(requests) ? requests : [] })
    }, { onError: () => { if (current) setContactRequests(null) } })
    return () => { current = false; live.stop() }
  }, [request, scope, state?.connected, state?.humanPrincipalId, state?.managementRevision])
  const pendingContacts = state?.connected && contactRequests?.scope === scope ? contactRequests.requests.filter(item => item.status === 'pending').length : 0
  useEffect(() => {
    if (!shown) return undefined
    const returning=Boolean(previousPanel.current&&!activePanel)
    previousPanel.current=activePanel
    const visible = node => !node.checkVisibility || node.checkVisibility()
    const controls = () => [...((activePanel ? chooser.current : frame.current)?.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[role=separator]') ?? [])]
      .filter(node => visible(node) && (!node.closest('details:not([open])') || node.tagName === 'SUMMARY'))
    const focusDefault = () => (activePanel ? controls()[0] : input.current && !input.current.disabled && visible(input.current) ? input.current : controls()[0])?.focus()
    if(returning&&chooserTrigger.current?.isConnected)chooserTrigger.current.focus()
    else focusDefault()
    // A host sign-in/first-run dialog may open above this restored surface.
    // Competing focus traps must not bounce focus indefinitely between portals.
    const foreignDialog = node => !frame.current?.contains(node) && node?.closest?.('dialog,[role="dialog"],[role="alertdialog"]')
    const retain = event => { if (!foreignDialog(event.target) && !(activePanel ? chooser.current : frame.current)?.contains(event.target)) focusDefault() }
    const keys = event => {
      if (foreignDialog(event.target) || event.target.closest?.('[data-action-menu]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); event.stopImmediatePropagation(); setNewMenuOpen(false); setSearchQuery(''); setSearchCursor(0); chooserTrigger.current = document.activeElement; setActivePanel('search'); return
      }
      if (newMenuShown.current && event.key === 'Tab') { setNewMenuOpen(false); return }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (newMenuShown.current) { setNewMenuOpen(false); newTrigger.current?.focus(); return }
        if (completionVisible.current) { setCompletion(null); return }
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
  }, [shown, browse, selected, member?.speakingMode, activePanel])
  useEffect(() => {
    if (!shown || !activePanel) return
    const returning = panelReturn.current
    panelReturn.current = ''
    const target=(returning ? chooser.current?.querySelector(`[data-open-panel="${returning}"]`) : null) ?? (activePanel==='thread'?(chooser.current?.querySelector('textarea')??chooser.current?.querySelector('button')):chooser.current?.querySelector(['group','search','history-search'].includes(activePanel)?'input':'button'))
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
  useEffect(() => { save(SELECTED, selected); setReply(null); setReferenced(null); pendingJump.current = null; referenceOrder.current += 1; setCompletion(null); autoScroll.current = true; input.current?.focus() }, [scope, selected])
  useEffect(()=>{
    const jump=searchJump.current
    if(!jump||!member||jump.scope!==scope||jump.conversationId!==selected)return
    searchJump.current=null
    if(jump.membershipEpoch!==member.membershipEpoch){setError('Earlier message unavailable');return}
    autoScroll.current=false;pendingJump.current={messageId:jump.messageId,context:contextKey.current};setReferenced(jump.messageId)
    void history.jumpTo(jump.conversationSeq)
  },[scope,selected,member?.membershipEpoch])
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
    if (!visible || activePanel || older !== null || page?.scope !== scope || page?.conversationId !== selected || page.membershipEpoch && page.membershipEpoch !== member?.membershipEpoch || !page.events.length) return undefined
    let active = true, marked = false, pending = false, focusFrame
    const mark = () => {
      if (marked || pending) return
      if (document.visibilityState === 'visible' && document.hasFocus() && autoScroll.current && !(window.innerWidth <= 760 && browse) && !document.querySelector('dialog[open]') && !frame.current?.querySelector('.bt-comm-members[open]')) {
        pending = true
        void conversationRequest({ endpoint: 'read', conversationId: selected, membershipEpoch:member.membershipEpoch,seq: page.events.at(-1).conversationSeq }).then(() => { marked = true; if (active) return refresh().catch(() => {}) }).catch(failure => {
        if (!active) return
        setSyncError({ conversationId: selected, message: friendly(failure) })
        if (['FORBIDDEN', 'NOT_A_MEMBER', 'MEMBERSHIP_REVOKED'].includes(failure.code)) history.clear()
      }).finally(() => { pending = false })
      }
    }
    const scroller=log.current, focusMark=()=>{cancelAnimationFrame(focusFrame);focusFrame=requestAnimationFrame(mark)}
    mark(); window.addEventListener('focus', mark); document.addEventListener('visibilitychange', mark); scroller?.addEventListener('scroll',mark); document.addEventListener('focusin',focusMark)
    return () => { active = false; window.removeEventListener('focus', mark); document.removeEventListener('visibilitychange', mark); scroller?.removeEventListener('scroll',mark); document.removeEventListener('focusin',focusMark); cancelAnimationFrame(focusFrame) }
  }, [scope, visible, activePanel, older, browse, selected, page, conversationRequest])
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
  const archiveConversation = async (item, archived) => {
    const requestedScope = scope, requestedStateScope = currentStateScope.current
    const value = await request({endpoint:'set-conversation-archived',conversationId:item.conversationId,membershipEpoch:item.membershipEpoch,
      localBotId:item.viewerBotId,archived,expectedScope:state.conversationPreferencesScope})
    if (currentStateScope.current !== requestedStateScope) return
    setState(current => communicationScope(current) === requestedScope ? {...current,archivedConversationIds:value.archivedConversationIds} : current)
    if (archived && selected === item.conversationId) setSelected(null)
  }
  const send = () => act(async () => {
    if(attachmentFlight.current)return
    if (!member || member.kind === 'group' && member.speakingMode !== 'speak' || !draft.text.trim() && !draft.attachments?.length) return
    const intent = attempts[key] ?? { endpoint: 'send', conversationId: selected, membershipEpoch: member.membershipEpoch, messageId: randomId(), clientCreatedAt: new Date().toISOString(),
      text: draft.text, mentions: draft.mentions, ...(draft.attachments?.length ? {attachments:draft.attachments} : {}), replyToMessageId: reply?.messageId ?? null }
    const next = { ...attempts, [key]: intent }; save(ATTEMPTS, next); setAttempts(next)
    // Only uncertain delivery locks editing for a same-ID retry. An explicit
    // rejection (for example UNKNOWN_MENTION) must leave the draft editable.
    try { await request(intent) }
    catch (failure) {
      if (!operationOutcomeUncertain(failure)) { delete next[key]; save(ATTEMPTS, next); setAttempts({ ...next }); setCompletion(null) }
      throw failure
    }
    delete next[key]; save(ATTEMPTS, next); setAttempts({ ...next })
    changeDraft({ text: '', mentions: [], manualMentions: [], attachments:[] }); setReply(null)
    await refresh(); input.current?.focus()
  })
  const choose = id => { setSelected(id); setBrowse(false); setError('') }
  const openReference = async messageId => {
    const context = contextKey.current, order = ++referenceOrder.current
    try {
      const event = await conversationRequest({ endpoint: 'reference', conversationId: selected, messageId })
      if (context !== contextKey.current || order !== referenceOrder.current) return
      autoScroll.current = false
      pendingJump.current = { messageId, context }
      setReferenced(messageId); setJumpRevision(value => value + 1)
      if (!page?.events.some(item => item.message?.messageId === messageId)) void history.jumpTo(event.conversationSeq)
    } catch {
      if (context === contextKey.current && order === referenceOrder.current) setError('Earlier message unavailable')
    }
  }
  const btn = (label, onClick, props = {}) => h('button', { type: 'button', disabled: busy, onClick, 'aria-label': t(label), ...props }, props.children ?? t(label))
  const chooseContact = (label, value, onChange, people) => h('details', { className: 'bt-comm-participant-picker' },
    h('summary', null, t(label), value ? ': ' : '', value ? personLabel(people.find(person => person.principalId === value) ?? { principalId: value }) : ''),
    contactsByAddress(people).map(group => h('section', { key: group.address, className: 'bt-comm-address' }, h('h3', null, t(group.address)), group.instances.map(instance => h('section', { key: instance.instanceId ?? 'unknown' }, h('p', { className: 'bt-comm-reference', title: instance.instanceId }, instance.label), instance.contacts.map(person => btn(labels.get(person.principalId) ?? person.displayName, event => { onChange(person.principalId); const details = event.currentTarget.closest('details'); details.open = false; details.querySelector('summary')?.focus() }, { key: person.principalId, 'aria-pressed': person.principalId === value, children: personLabel(person) })))))))
  if (!shown) return null
  const events = page?.scope === scope && page?.conversationId === selected && page?.membershipEpoch === member?.membershipEpoch ? page.events : []
  const visibleIds = new Set(events.map(event => event.message?.messageId))
  const ownOutbox = member ? (state?.outbox ?? []).filter(item => (!item.principalId || item.principalId === state.humanPrincipalId) && item.type === 'message.publish' && item.conversationId === selected) : []
  const activityOutbox = (state?.outbox ?? []).filter(item => (!item.principalId || item.principalId === state.humanPrincipalId) && item.type === 'message.publish' && (!member || item.conversationId === selected))
  const currentMembers = member?.info?.members ?? []
  const knownMembers = [...currentMembers, ...(member?.info?.formerMembers ?? [])]
  const canSpeak = member && !member.archive && !currentMembers.some(person => person.retired) && (member.kind !== 'group' || member.speakingMode === 'speak')
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
  const inspect = (ids,trigger) => { const authorized = ids.filter(id => [...currentMembers, ...(member?.info?.formerMembers ?? [])].some(person => person.principalId === id)); if (authorized.length) { setInspectedIds(authorized); showPanel('participant',trigger) } }
  const showPanel = (name, trigger) => { setCompletion(null); setPanelBack(''); setNewMenuOpen(false); chooserTrigger.current = newMenuOpen ? newTrigger.current : trigger ?? document.activeElement; if (name === 'search') { setSearchQuery(''); setSearchCursor(0) }; setActivePanel(name) }
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
  const compatibility = state?.compatibility ?? communicationCompatibility(null, state?.error)
  const versionBlocked = incompatibleCommunication(state?.error) || compatibility.status === 'incompatible'
  const clientOlder = communicationReleaseRelation(compatibility.clientVersion, compatibility.hubVersion) === 'client-older'
  const updateClient = versionBlocked && (compatibility.updateTarget === 'client' || compatibility.updateTarget !== 'hub' && clientOlder)
  const versionNotice = versionBlocked ? updateClient ? 'Update the client to use this Hub. Its required protocol or capabilities are not supported.' : compatibility.updateTarget === 'hub' ? 'Update the Hub to support this client’s required protocol and capabilities.' : 'Update the client or Hub to compatible protocol and capability versions.' : clientOlder ? 'A newer client release is available. Update the client; communication remains available with compatible protocols and capabilities.' : 'The release versions differ. Communication remains available with compatible protocols and capabilities.'
  const connectionLabel = !team.communicationEnabled ? 'Not configured' : versionBlocked ? updateClient ? 'Client update required to connect' : 'Client and Hub versions are incompatible' : pollError ? 'Offline' : !state ? 'Connecting…' : state.connected ? 'Connected to Hub' : connectionBlocked ? 'Offline' : 'Reconnecting to Hub'
  const compactConnection = Boolean(state?.connected && !pollError && !versionBlocked)
  const versionDetails = `${t('Client')}: ${displayCommunicationVersion(compatibility.clientVersion) ?? t('Version not reported')} · Hub: ${displayCommunicationVersion(compatibility.hubVersion) ?? t('Version not reported')}`
  const roleLabel = role => role === 'owner' ? 'Group owner' : role === 'admin' ? 'Group admin' : 'Group member'
  const avatar = (id, name) => {
    const contact = contacts.find(person => person.principalId === id)
    return h(CommunicationAvatar, { person: contact ?? { principalId: id, displayName: name ?? id, kind: id?.startsWith('bot:') ? 'bot' : id?.startsWith('human:') ? 'human' : 'group' }, request, allowed: Boolean(contact) })
  }
  const messageAvatar = (id,name) => member?.kind === 'group' && [...currentMembers,...(member.info?.formerMembers ?? [])].some(person=>person.principalId===id)
    ? h('button',{type:'button',className:'bt-comm-avatar-button','aria-label':t('View profile of {name}',{name:labels.get(id)??name??t('Participant')}),onClick:event=>inspect([id],event.currentTarget)},avatar(id,name)) : avatar(id,name)
  const identityIcons = person => {
    const kind = person.kind ?? (person.principalId?.startsWith('bot:') ? 'bot' : 'human')
    const instanceId = person.homeInstanceId ?? person.principalId?.split(':')[1]
    return h(Fragment, null,
      h('span', { className: 'bt-comm-kind-icon', 'aria-label': t(kind === 'bot' ? 'Bot' : 'Human'), title: t(kind === 'bot' ? 'Bot' : 'Human'), 'data-symbol': kind === 'bot' ? '◇' : '○' }),
      instanceId && instanceId !== state?.instanceId ? h('span', { className: 'bt-comm-kind-icon', 'aria-label': t('Remote'), title: t('Remote'), 'data-symbol': '↗' }) : null)
  }
  const personLabel = (person,inspectAvatar=false) => h('span', { className: 'bt-comm-person-label', title: `${person.displayName ?? ''} · ${person.instanceLabel ?? person.homeInstanceId ?? ''} · ${person.principalId}` }, inspectAvatar ? messageAvatar(person.principalId,person.displayName) : avatar(person.principalId, person.displayName), labels.get(person.principalId) ?? person.displayName ?? person.principalId, identityIcons(person))
  const groupedContacts = render => contactsByAddress(contacts.filter(person => person.principalId !== state?.humanPrincipalId && !(person.kind === 'bot' && (person.homeInstanceId === state?.instanceId || person.ownerPrincipalId === state?.humanPrincipalId || person.principalId.startsWith(`bot:${state?.instanceId}:`))))).map(group => h('section', { key: group.address, className: 'bt-comm-address' },
    h('h3', null, t(group.address)), group.instances.map(instance => h('section', { key: instance.instanceId ?? 'unknown' }, h('p', { className: 'bt-comm-reference', title: instance.instanceId }, instance.label), instance.contacts.map(render)))))
  const invitations = invitationGroups(state?.invites)
  const invitation = invitations.find(item => item.key === invitationKey)
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
    ...allConversations.filter(item => !archivedIds.has(item.conversationId)).filter(item => [conversationTitle(item,state.humanPrincipalId,labels),item.lastMessage?.summary,...(item.info?.members ?? []).map(person=>person.displayName)].some(searchable)).map(item => ({ id:item.conversationId, title:conversationTitle(item,state.humanPrincipalId,labels), preview:item.lastMessage?.summary ?? '', avatar:h(ConversationAvatar,{conversation:item,humanId:state.humanPrincipalId,request,size:24}), run:()=>{setActivePanel('');choose(item.conversationId)} })),
    ...contacts.filter(person=>person.principalId !== state?.humanPrincipalId && [labels.get(person.principalId),person.displayName,person.instanceLabel].some(searchable)).map(person=>({ id:person.principalId,title:labels.get(person.principalId) ?? person.displayName,preview:t('New message'),avatar:h(CommunicationAvatar,{person,request,size:24}),run:()=>{void act(async()=>{const value=await operation('dm',{otherPrincipalId:person.principalId});setActivePanel('');choose(value.conversationId)})} })),
  ].slice(0,50)
  const searchIndex = Math.max(0, Math.min(searchCursor, searchResults.length-1))

  return createPortal(h(CommunicationPresence,{state,unavailable:Boolean(pollError)},h('section', { ref: frame, className: 'bt-comm-frame', style:{'--bt-comm-left-width':`${columnWidths.left}px`,'--bt-comm-right-width':`${shownRightWidth}px`,'--bt-tap-duration':`${SPRING_TAP.duration}ms`,'--bt-tap-easing':SPRING_TAP.easing}, role: 'dialog', 'aria-modal': true, 'data-closing': closing, 'data-collapsed': sidebarHidden, 'data-browse': browse || !member, 'data-setup': !team.communicationEnabled, 'aria-label': t('Remote communication') },
    h('aside', { id:'bt-comm-nav', className: 'bt-comm-nav' },
      h('div', { className: 'bt-comm-nav-heading' }, h('h2', {title:t('Remote communication')}, t('Remote communication')),
        h('div', { className:'bt-comm-nav-actions' },
          btn('Personal settings', event => showPanel('settings', event.currentTarget), { className: 'bt-comm-settings-icon', 'aria-label': t('Personal settings'), title: t('Personal settings'), children: h(GearIcon) }),
          btn('Contacts', event => showPanel('manage-contacts', event.currentTarget), { className: 'bt-comm-settings-icon', 'aria-label': t('Contacts'), title: t('Contacts'), 'aria-describedby': pendingContacts ? 'bt-comm-contact-pending' : undefined, disabled: busy || !team.communicationEnabled, children: h(Fragment, null, h(PeopleIcon), pendingContacts ? h('span', { id: 'bt-comm-contact-pending', className: 'bt-comm-request-badge', role: 'status', 'aria-label': `${pendingContacts} ${t('pending')}` }, pendingContacts > 99 ? '99+' : pendingContacts) : null) }),
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
      h('div', { className: 'bt-comm-nav-scroll' },
      member ? btn('Back to conversation', () => setBrowse(false), { className: 'bt-comm-mobile' }) : null,
      state ? h(CommunicationWorkApprovals, {key:scope,state,request,refresh}) : null,
      h('section', { className: 'bt-comm-connection', 'aria-label': t('Connection status'), 'data-compact': compactConnection },
        h('div', { className: 'bt-comm-connection-line', title: `${t(connectionLabel)} · ${versionDetails}${compatibility.status === 'different' ? ` · ${t(versionNotice)}` : ''}`, 'aria-description': compactConnection && compatibility.status === 'different' ? t(versionNotice) : undefined },
          h('p', { className: 'bt-comm-connection-label', role: 'status', 'data-connected': Boolean(state?.connected && !pollError) }, h('span', { className: 'bt-comm-dot', 'aria-hidden': true }), t(connectionLabel)),
          team.communicationEnabled && state ? h('span', { className: 'bt-comm-reference', 'data-communication-versions': true, 'aria-label': versionDetails }, displayCommunicationVersion(compatibility.clientVersion), ' / ', displayCommunicationVersion(compatibility.hubVersion) ?? t('Version not reported'), compactConnection && clientOlder ? ' ↑' : '') : null),
        team.communicationEnabled && !compactConnection && (versionBlocked || compatibility.status === 'different') ? h('p', { className: 'bt-comm-reference', role: 'status' }, t(versionNotice)) : null,
        team.communicationEnabled && versionBlocked && state?.error ? h('p', { className: 'bt-comm-reference', role: 'status' }, friendly({ code: state.error })) : null,
        state ? h('p', { className: 'bt-comm-reference bt-comm-connection-details' }, `${state.instanceId} · ${t('Remote contacts')}: ${remoteCount}`) : null,
        pollError ? h('p', { className: 'bt-comm-reference', role: 'status' }, t('Status may be out of date.'), ' ', pollError) : null,
        team.communicationEnabled && !state?.connected && !connectionBlocked ? h('p', { className: 'bt-comm-reference' }, t('Queued messages send automatically when the connection returns.')) : null,
        null),
      h('div', { className: 'bt-comm-section-title' }, t('Conversations'), h('span', null, visibleConversations.length)),
      h('nav', { 'aria-label': t('Communication conversations') }, visibleConversations.map(item =>
        h(ConversationRow, { key: item.conversationId, conversation: item, humanId: state.humanPrincipalId, labels, request, selected: item.conversationId === selected, onChoose: choose, disabled: busy, onArchive:item.kind==='dm'?item=>act(()=>archiveConversation(item,true)):undefined }))),
      visibleBotConversations.length ? h(Fragment, null, h('div', { className: 'bt-comm-section-title' }, t('Bot private chats'), h('span', null, visibleBotConversations.length)),
        h('nav', { 'aria-label': t('Bot private chats') }, visibleBotConversations.map(item => h(ConversationRow, { key: item.conversationId, conversation: item, humanId: item.viewerPrincipalId, labels, request, selected: item.conversationId === selected, onChoose: choose, disabled: busy, onArchive:item.kind==='dm'?item=>act(()=>archiveConversation(item,true)):undefined })))) : null,
      archivedConversations.length ? btn('Archived private chats', event => showPanel('archives', event.currentTarget), {className:'bt-comm-archive-entry',children:h(Fragment,null,h(ArchiveIcon),t('Archived private chats'),h('span',{className:'bt-comm-count'},archivedConversations.length))}) : null,
      !visibleConversations.length && !visibleBotConversations.length ? h('p', { className: 'bt-comm-reference' }, t('Your cross-device conversations will appear here.')) : null,
      invitations.length ? h('div', { className: 'bt-comm-invitations' }, h('h3', null, t('Invitations')), invitations.map(item =>
        btn(item.title, event => { setInvitationKey(item.key); showPanel('invitation', event.currentTarget) }, { key: item.key, 'data-invitation-group': item.key, children: h(Fragment, null, item.title, h('span', { className: 'bt-comm-count' }, item.targets.length)) }))) : null,
      null),
      h(CommunicationResizeHandle,{side:'left',width:columnWidths.left,onChange:changeColumnWidth}),
      h('div', { className: 'bt-comm-nav-footer' }, btn('Back to local chats', close, { className: 'bt-comm-back' }))),
    activePanel ? h('div', { className: `bt-comm-modal-backdrop${activePanel==='thread'?' bt-comm-thread-backdrop':''}`, onMouseDown: event => { if (event.target === event.currentTarget) { setActivePanel(''); chooserTrigger.current?.focus() } } },
      h('section', { ref: chooser, className: `bt-comm-modal${activePanel==='thread'?' bt-comm-thread-popover':''}${activePanel==='manage-contacts'?' bt-comm-contacts-modal':''}`,style:activePanel==='thread'?threadPosition:undefined, role: 'dialog', 'aria-modal': true, 'aria-label': t(activePanel === 'archives' ? 'Archived private chats' : activePanel === 'invitation' ? 'Invitation details' : activePanel === 'history-search' ? 'Search chat history' : activePanel === 'search' ? 'Search' : activePanel === 'settings' ? 'Personal settings' : activePanel === 'thread' ? 'Message replies' : activePanel === 'activity' ? 'Activity details' : activePanel === 'participant' ? 'Participant information' : activePanel === 'manage-contacts' ? 'Manage contacts' : activePanel === 'profile' ? 'Human profile' : activePanel === 'pairing' ? 'Add a device' : activePanel === 'group' ? 'New group' : 'New message') },
        activePanel==='thread'?h('button',{type:'button',onClick:()=>{setActivePanel('');chooserTrigger.current?.focus()},className:'bt-comm-thread-close','aria-label':t('Close replies'),title:t('Close replies')},h(CloseIcon)):null,
        h('div', { className: activePanel === 'thread' ? 'bt-comm-thread-heading' : 'bt-comm-modal-head' },
          h('h2', null, t(activePanel === 'archives' ? 'Archived private chats' : activePanel === 'invitation' ? 'Invitation details' : activePanel === 'history-search' ? 'Search chat history' : activePanel === 'search' ? 'Search' : activePanel === 'settings' ? 'Personal settings' : activePanel === 'thread' ? 'Message replies' : activePanel === 'activity' ? 'Activity details' : activePanel === 'participant' ? 'Participant information' : activePanel === 'manage-contacts' ? 'Manage contacts' : activePanel === 'profile' ? 'Human profile' : activePanel === 'pairing' ? 'Add a device' : activePanel === 'group' ? 'New group' : 'New message')),
          activePanel !== 'thread' ? h('div', { className: 'bt-comm-modal-actions' },
            panelBack ? h('button', { type: 'button', 'aria-label': t('Back to settings'), onClick: () => { panelReturn.current = activePanel; setActivePanel(panelBack); setPanelBack('') } }, h(ChevronLeftIcon), t('Back')) : null,
            h('button', { type: 'button', 'aria-label': t('Close dialog'), onClick: () => { setActivePanel(''); setPanelBack(''); chooserTrigger.current?.focus() } }, h(CloseIcon), t('Close'))) : null),
        activePanel === 'archives' ? h('div', null, h('p',{className:'bt-comm-reference'},t('Archived chats stay hidden until you restore them. Messages continue to be received and saved.')),
          archivedConversations.map(item => h('div',{key:item.conversationId,className:'bt-comm-archive-row'},h(ConversationRow,{conversation:item,humanId:item.viewerPrincipalId ?? state.humanPrincipalId,labels,request,selected:false,disabled:busy,onChoose:id=>{choose(id);setActivePanel('')}}),btn('Restore private chat',()=>{void act(()=>archiveConversation(item,false))},{'aria-label':`${t('Restore private chat')} ${conversationTitle(item,state.humanPrincipalId,labels)}`}))),
          !archivedConversations.length ? h('p',{role:'status'},t('No archived private chats.')) : null) : activePanel === 'invitation' ? h(InvitationDetails, { invitation, busy, onAccept: () => { void act(async () => { for (const target of [...invitation.targets].sort((a,b) => Number(b.principalId.startsWith('human:')) - Number(a.principalId.startsWith('human:')))) await operation('accept', { inviteId: target.inviteId, recipientPrincipalId: target.principalId }); setActivePanel(''); choose(invitation.conversationId) }) } }) : activePanel === 'search' ? h('div',{className:'bt-comm-search'},
          h('label',{className:'bt-comm-field'},t('Search conversations and contacts'),h('input',{value:searchQuery,role:'combobox','aria-label':t('Search conversations and contacts'),'aria-autocomplete':'list','aria-expanded':true,'aria-controls':'bt-comm-search-results','aria-activedescendant':searchResults.length?`bt-comm-search-${searchIndex}`:undefined,onChange:event=>{setSearchQuery(event.target.value);setSearchCursor(0)},onKeyDown:event=>{
            if(event.nativeEvent.isComposing)return
            if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();setSearchCursor(index=>!searchResults.length?0:event.key==='Home'?0:event.key==='End'?searchResults.length-1:(index+(event.key==='ArrowDown'?1:-1)+searchResults.length)%searchResults.length)}
            if(event.key==='Enter'&&searchResults.length){event.preventDefault();searchResults[searchIndex].run()}
          }})),h('p',{className:'bt-comm-reference'},t('Search current conversations, contacts and recent message summaries.')),
          h('div',{id:'bt-comm-search-results',role:'listbox','aria-label':t('Results')},searchResults.map((item,index)=>btn(item.title,item.run,{key:item.id,id:`bt-comm-search-${index}`,role:'option','aria-selected':index===searchIndex,children:h(Fragment,null,item.avatar,h('span',null,h('strong',null,item.title),h('small',null,item.preview)))}))),
          !searchResults.length?h('p',{role:'status'},t('No matching conversations or contacts.')):null,btn('Search chat history',event=>{setHistorySearchScope('');showPanel('history-search',event.currentTarget)})) : activePanel === 'history-search' ? h(CommunicationHistorySearch,{request,initialConversationId:historySearchScope,conversations:allConversations.map(item=>({...item,searchTitle:conversationTitle(item,state?.humanPrincipalId,labels)})),onSelect:item=>{setActivePanel('');searchJump.current={...item,scope};if(selected===item.conversationId){searchJump.current=null;autoScroll.current=false;pendingJump.current={messageId:item.messageId,context:contextKey.current};setReferenced(item.messageId);void history.jumpTo(item.conversationSeq)}else choose(item.conversationId)}}) : activePanel === 'settings' ? h('div', { className: 'bt-comm-personal-settings' },
          state ? h(Fragment, null, h('details', {className:'bt-comm-contact-section bt-comm-profile-section'}, h('summary', null, t('Your profile')), h(HumanProfile, { key: `${scope}:${state.humanPrincipalId}`, human: contacts.find(person => person.principalId === state.humanPrincipalId) ?? { principalId: state.humanPrincipalId, displayName: t('You'), kind: 'human' }, request, operation })),
            h('details', {className:'bt-comm-contact-section bt-comm-profile-section'}, h('summary', null, t('Device identity')), h('p', null, state.instanceId), h('code', null, state.humanPrincipalId))) : null,
          h(OwnRemoteProfile, { key: `own:${scope}`, request, operation, bots: team.bots, revision: `${state?.managementRevision}:${team.revision}` }),
          h(CommunicationMemory, { key: scope, request, revision:state?.managementRevision }),
          h('details', {className:'bt-comm-contact-section bt-comm-profile-section'}, h('summary', null, t('Hub connection')), btn('Join Hub', () => { setPanelBack('settings'); setActivePanel('pairing') }, { 'data-open-panel': 'pairing' }))) : activePanel === 'thread' ? member && threadMessageId ? h(Fragment,null,h(CommunicationThread, { key: `view:${contextKey.current}:${threadMessageId}`, member, messageId: threadMessageId, request, canSpeak, onInspect: inspect,
          chronological:true,onReply:setThreadReplyTarget }),canSpeak&&threadReplyTarget?h(ThreadReplyComposer,{key:`composer:${contextKey.current}:${threadMessageId}`,storageKey:`ds-bot:communication:thread:${contextKey.current}:${threadMessageId}`,member,target:threadReplyTarget,request,replyMentionUnion:state.replyMentionUnionAvailable===true,directedReplies:state.directedGroupRepliesAvailable===true,onSent:refresh,attachmentsAvailable:state.attachmentsAvailable}):null) : null : activePanel === 'activity' ? h(CommunicationActivity, { state, member, events, outbox: activityOutbox, operations, operationPending: pendingForConversation, pendingAttempt: attempts[key], error, pollError: pollError || (syncError?.conversationId === selected ? syncError.message : ''), friendly, labels, busy,
          onRetry: () => { setActivePanel(''); void send() }, copyDisabled: Boolean(draft.text) || Boolean(attempts[key]) || !member,
          onCopy: item => { if (draft.text || attempts[key] || !member) return; changeDraft({ text: item.text, mentions: [], manualMentions: [] }); setActivePanel(''); input.current?.focus() } }) : activePanel === 'participant' ? h('div', { className: 'bt-comm-participant-information' }, [...currentMembers, ...(member?.info?.formerMembers ?? [])].filter(person => inspectedIds.includes(person.principalId)).map(person => h(ParticipantInformation, { key: person.principalId, person, people: [...currentMembers, ...(member?.info?.formerMembers ?? []), ...contacts], request, conversationId: selected, membershipEpoch: member.membershipEpoch, localBotId: member.viewerBotId, roleLabel, personLabel }))) : activePanel === 'manage-contacts' ? h(ContactManager, { key: scope, request, operation, contacts, connectionKnown: state?.connected === true && !pollError, revision: `${state?.managementRevision ?? ''}:${state?.connected ?? false}`, humanPrincipalId: state?.humanPrincipalId, instanceId: state?.instanceId, onMessage: messageContact, messageBusy: busy }) : activePanel === 'profile' ? h(HumanProfile, { key: scope, human: contacts.find(person => person.principalId === state?.humanPrincipalId) ?? { principalId: state?.humanPrincipalId ?? 'human:local', displayName: t('You'), kind: 'human' }, request, operation }) : activePanel === 'pairing' ? h(AddDevice, { request, revision: `${team.communicationEnabled}:${team.communicationHubId}:${state?.managementRevision ?? ''}:${state?.connected ?? false}`, displayName: contacts.find(person => person.principalId === state?.humanPrincipalId)?.displayName }) : h(Fragment, null,
        activePanel === 'group' ? h('label', { className: 'bt-comm-field' }, t('Group name'), h('input', { value: title, onChange: event => setTitle(event.target.value), 'aria-label': t('Group name') })) : null,
        activePanel === 'group' ? h(GroupBotChoices, { contacts, humanId: state?.humanPrincipalId, instanceId: state?.instanceId, selected: invitees, onChange: setInvitees, request }) : groupedContacts(contact =>
          btn(labels.get(contact.principalId), () => { void act(async () => { const value = await operation('dm', { otherPrincipalId: contact.principalId }); choose(value.conversationId); setActivePanel('') }) }, { key: contact.principalId, className: 'bt-comm-contact', children: personLabel(contact) })),
        !contacts.some(person => person.principalId !== state?.humanPrincipalId) ? h('p', { className: 'bt-comm-reference' }, t('Remote contacts appear after the other device connects and publishes its identities.')) : null,
        activePanel === 'group' ? btn('Create and invite', () => { void act(async () => {
          const value = await operation('create-group', { title }); if (!value.conversationId) return
          choose(value.conversationId); setTitle(''); setInvitees([]); setActivePanel('')
          const failed = []
          for (const inviteePrincipalId of invitees.filter(id => contacts.some(person => person.principalId === id && person.kind === 'bot'))) { try { await operation('invite', { conversationId: value.conversationId, inviteePrincipalId }) } catch { failed.push(labels.get(inviteePrincipalId) ?? inviteePrincipalId) } }
          if (failed.length) setError(t('Group created. Some invitations were not sent. Open the member settings to invite them.') + ' ' + failed.join(', '))
        }) }, { className: 'bt-comm-primary', disabled: busy || !title.trim() }) : null),
        btn(activePanel === 'pairing' ? 'Close' : 'Cancel', () => { setActivePanel(''); chooserTrigger.current?.focus() }))) : null,
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
        member?.kind === 'dm' ? btn(archivedIds.has(member.conversationId) ? 'Restore private chat' : 'Archive private chat', () => {void act(()=>archiveConversation(member,!archivedIds.has(member.conversationId)))}, {className:'bt-comm-icon-button','aria-label':t(archivedIds.has(member.conversationId) ? 'Restore private chat' : 'Archive private chat'),title:t(archivedIds.has(member.conversationId) ? 'Restore private chat' : 'Archive private chat'),children:h(ArchiveIcon)}) : null,
        member ? btn('Search chat history',event=>{setHistorySearchScope(member.conversationId);showPanel('history-search',event.currentTarget)},{className:'bt-comm-icon-button','aria-label':t('Search chat history'),title:t('Search chat history'),children:h(SearchIcon)}) : null,
        btn('Activity details', event => showPanel('activity', event.currentTarget), { className: 'bt-comm-icon-button', 'aria-label': t('Activity details'), title: t('Activity details'), children: h(InfoIcon) }),
        member?.kind === 'group' ? h('span', { className: 'bt-sr' }, `${currentMembers.length} ${t('Members')} · ${t(roleLabel(member.role))} · ${t(member.speakingMode === 'readOnly' ? 'Read only' : 'Can speak')}`) : null),
      !member ? h('section', { className: 'bt-comm-empty' },
        h('span', { className: 'bt-comm-empty-symbol', 'aria-hidden': true }, '↔'),
        h('h2', null, t(team.communicationEnabled ? 'Start a conversation across devices' : 'Pair this device to get started')),
        h('p', null, t(team.communicationEnabled ? 'Message a Human or Bot directly, or bring them together in a group.' : 'Ask the Hub owner to configure communication and pair this device.')),
        team.communicationEnabled ? btn('New…',startMenu,{className:'bt-comm-primary'}) : null,
        h('p', { className: 'bt-comm-reference' }, t('Local chats stay separate from communication conversations.'))) : null,
      member?.archive ? h('p', { className: 'bt-comm-reference bt-comm-archive-notice', role: 'status' }, t('Read-only record of your Bot’s private conversation.')) : null,
      member?.kind === 'group' ? h(GroupSettings, { columnWidth:shownRightWidth,onColumnWidth:changeColumnWidth,multipleAvailable:state.multipleDefaultBotsAvailable===true,groupProfilesAvailable:state.groupProfilesAvailable===true,key: `${scope}:${selected}:${member.membershipEpoch}`, member, contacts, labels, operation, operationPending, act, busy, humanId: state.humanPrincipalId, btn, personLabel, chooseContact, request, onInspect:(ids,trigger)=>{setInspectedIds(ids);showPanel('participant',trigger)},
        pendingInvites:()=>[...operationIds.current.keys()].flatMap(key=>{const [instanceId,endpoint,values]=JSON.parse(key);return instanceId===scope&&endpoint==='invite'&&values.conversationId===selected&&values.membershipEpoch===member.membershipEpoch?[values]:[]}),
        pendingSettings: id => [...operationIds.current.keys()].map(item => JSON.parse(item)).find(([instanceId, endpoint, values]) => instanceId === scope && endpoint === 'save-settings' && values.conversationId === id)?.[2] ?? null }) : null,
      h('div', { ref: log, className: 'bt-comm-log', role: 'log', 'aria-label': t('Communication messages'), onScroll: event => {
        const element = event.currentTarget; autoScroll.current = !referenced && !pendingJump.current && element.scrollHeight - element.scrollTop - element.clientHeight < 80
        if(element.scrollTop<80)void history.loadEarlier()
        else if(element.scrollHeight-element.scrollTop-element.clientHeight<80)void history.loadLater()
      } },
        page?.hasEarlier ? btn('Load earlier messages', () => {void history.loadEarlier()}, {disabled:history.loading}) : null,
        page?.hasLater ? btn('Show latest messages', () => {pendingJump.current=null;setReferenced(null);void history.showLatest()}) : null,
        history.loading ? h('p',{className:'bt-comm-history-status',role:'status'},t('Loading messages…')) : history.failure ? btn('Retry loading messages',()=>{void history.retry()}) : null,
        communicationLogEvents(events).map(event => event.type !== 'message' ? h(BotWorkStatus, { key: event.eventId, event, members: knownMembers, request, onInspect: inspect }) : h('article', { key: event.message.messageId, 'data-message-id': event.message.messageId, 'data-self': event.message.author.principalId === state.humanPrincipalId, 'data-referenced': event.message.messageId === referenced },
          messageAvatar(event.message.author.principalId, contacts.find(person => person.principalId === event.message.author.principalId)?.displayName ?? event.message.author.displayName), h('strong', { title: event.message.author.principalId }, labels.get(event.message.author.principalId) ?? event.message.author.displayName ?? (event.message.author.principalId === state.humanPrincipalId ? t('You') : event.message.author.principalId), identityIcons(contacts.find(person => person.principalId === event.message.author.principalId) ?? event.message.author)),
          h('div', { className: 'bt-comm-message-bubble' }, event.message.replyToMessageId ? h(ReferenceQuote, { key: `${scope}:${selected}:${member.membershipEpoch}:${event.message.replyToMessageId}`, conversationId: selected,
            membershipEpoch: member.membershipEpoch, messageId: event.message.replyToMessageId, request: conversationRequest, labels, onJump: openReference }) : null,
          h('div', { className: 'bt-comm-body' }, h(CommunicationMessage, { message: event.message, members: knownMembers, request, onInspect: inspect }))),
          h(CommunicationActivation,{event,members:[...currentMembers,...(member.info?.formerMembers??[])],request:conversationRequest}),
        h(CommunicationMessageActions,{message:event.message,onReply:canSpeak?openThread:undefined,
            onThread:member.kind==='group'?(message,trigger)=>openThread(message,trigger,false):undefined},
            h('time', { title: new Date(event.serverAcceptedAt).toLocaleString() }, new Date(event.serverAcceptedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))))),
        ownOutbox.filter(item => item.state !== 'failed' && !visibleIds.has(item.id) && (item.state !== 'accepted' || older === null && item.result?.conversationSeq > (page?.watermark ?? 0))).map(item => h('article', { key: item.id, 'data-message-id': item.id, 'data-self': true, 'data-failed': item.state === 'failed' },
          messageAvatar(state.humanPrincipalId, contacts.find(person => person.principalId === state.humanPrincipalId)?.displayName), h('strong', { title: state.humanPrincipalId }, contacts.find(person => person.principalId === state.humanPrincipalId)?.displayName ?? t('You'), identityIcons({ principalId: state.humanPrincipalId, kind: 'human', homeInstanceId: state.instanceId })), h('p', { className: 'bt-comm-pending-text' }, item.text), h(CommunicationActivation,{event:item.result,members:currentMembers,request:conversationRequest,pending:true}), h('p', { role: 'status' }, t(item.state === 'accepted' ? 'Hub accepted' : 'Queued on this device'))))),
      currentMembers.some(person => person.retired) ? h('p', { role: 'status', className: 'bt-comm-reference' }, t('This Bot identity no longer exists. This chat is read only. A re-published Bot must start a new chat.')) : null,
      canSpeak ? h('footer', null,
        h(RecipientPreview,{member,draft:attempts[key]??draft,target:reply,request,replyMentionUnion:state.replyMentionUnionAvailable===true,directedReplies:state.directedGroupRepliesAvailable===true}),
        reply ? h('div', { className: 'bt-comm-reference' }, `${t('Reply to')} ${reply.content.text.slice(0,120)}`, btn('Cancel reply', () => setReply(null))) : null,
        h('div', { className: 'bt-comm-mentions' }, (draft.mentions ?? []).map(id => btn(`@${labels.get(id) ?? id} ×`, () => changeDraft({ mentions: draft.mentions.filter(item => item !== id), manualMentions: (draft.manualMentions ?? []).filter(item => item !== id) }), { key: id, 'data-manual-mention': (draft.manualMentions ?? []).includes(id), 'aria-label': `${t('Remove mention')}: ${labels.get(id) ?? id}` }))),
        suggestions.length ? h('div', { className: 'bt-comm-completion', role: 'listbox', id: 'bt-comm-completion', 'aria-label': t('Mention participant') }, suggestions.map((person, index) =>
          h('button', { type: 'button', key: person.principalId, id: `bt-comm-option-${index}`, role: 'option', 'aria-selected': completionIndex === index,
            onMouseDown: event => event.preventDefault(), onClick: () => complete(person) }, h(MentionPerson,{person,members:currentMembers,request})))) : null,
        h('label', { className: 'bt-comm-field bt-comm-compose-field' }, h('span', { className: 'bt-sr' }, t('Communication message')), h('textarea', { ref: input, value: draft.text, rows: 4, placeholder: t('Message {name}', { name: conversationTitle(member, state.humanPrincipalId, labels) }), disabled: !canSpeak || Boolean(attempts[key]),
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
        null) : null))), document.body)
}

export function installCommunication(ctx, { roster, surface }) {
  const panel = createSource(read(OPEN, false))
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = communicationCSS + communicationDirectoryCSS; document.head.append(style)
    return () => style.remove()
  }, 'ds-bot: communication styles')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'bot-communication', order: 52 },
    () => h(CommunicationSurface, { roster, surface, panel })))
  return { open: () => { if (!remoteHubVisible(roster.getSnapshot())) return false; save(OPEN, true); panel.set(true); return true } }
}
