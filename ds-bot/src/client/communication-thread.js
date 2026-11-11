import {RecipientPreview} from './communication-recipient-preview.js'
import { useMentionDismiss } from './communication-mentions.js'
import { useLiveRefresh } from './communication-live.js'
import { readCommunicationBrowserState, saveCommunicationBrowserState } from './communication-reset.js'
import { randomId } from './random-id.js'
import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { contactLabels, referenceExcerpt, mentionQuery, mentionChoices, insertMention, retainedMentions } from './communication-model.js'
import { CommunicationAvatar } from './communication-profile.js'
import { CommunicationMessage } from './communication-message.js'
import { CommunicationMessageActions } from './communication-message-actions.js'
import { selectedAttachments } from './communication-attachments.js'
import { communicationFailure, operationOutcomeUncertain } from './communication-errors.js'
import { ArrowUpIcon, PlusIcon, CloseIcon } from './icons.js'

// Viewing replies never creates a message, marks unseen main-history pages read,
// or changes the Bot causal budget. Reply uses the existing composer intent.
export function CommunicationThread({ member, messageId, request, canSpeak, onReply, onInspect, chronological = false }) {
  const [page, setPage] = useState(null), [error, setError] = useState(false), [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState(new Set()), [recovery, setRecovery] = useState(0)
  const failedRead = useRef(false)
  const order = useRef(0), current = useRef(null)
  current.current = page
  const members = [...(member.info?.members ?? []), ...(member.info?.formerMembers ?? [])], labels = contactLabels(members)
  useEffect(() => {
    const token = ++order.current
    failedRead.current = false
    setPage(null); setCollapsed(new Set()); setError(false); setLoading(true)
    void request({ endpoint: 'thread', conversationId: member.conversationId, membershipEpoch: member.membershipEpoch, messageId }).then(async value => {
      if (chronological && !value.events?.some(event => event.message?.messageId === messageId)) {
        const selected = await request({ endpoint: 'reference', conversationId: member.conversationId, membershipEpoch: member.membershipEpoch, messageId })
        if (selected.message?.messageId === messageId) value = { ...value, events: [...(value.events??[]), selected] }
      }
      if (token === order.current && value.conversationId === member.conversationId && value.membershipEpoch === member.membershipEpoch && value.messageId === messageId) setPage(value)
    }).catch(() => { if (token === order.current) { failedRead.current = true; setPage(null); setError(true) } }).finally(() => { if (token === order.current) setLoading(false) })
    return () => { order.current += 1 }
  }, [member.conversationId, member.membershipEpoch, member.watermark, messageId, request, chronological, recovery])
  useLiveRefresh(async () => { if (failedRead.current) { failedRead.current = false; setRecovery(value => value + 1) } }, () => {}, request)
  const more = async () => {
    if (loading || !page?.hasMore) return
    const token = ++order.current, base = page
    setLoading(true); setError(false)
    try {
      const value = await request({ endpoint: 'thread', conversationId: member.conversationId, membershipEpoch: member.membershipEpoch, messageId, after: page.nextAfter, watermark: page.watermark })
      if (token === order.current && current.current === base && value.conversationId === member.conversationId && value.membershipEpoch === member.membershipEpoch && value.rootMessageId === base.rootMessageId && value.watermark === base.watermark) setPage({ ...value, events: [...new Map([...base.events, ...value.events].map(event => [event.message.messageId,event])).values()] })
    } catch { if (token === order.current) { failedRead.current = true; setPage(null); setError(true) } }
    finally { if (token === order.current) setLoading(false) }
  }
  const messages = new Map((page?.events ?? []).map(event => [event.message.messageId, event.message]))
  const children = new Map()
  for (const event of page?.events ?? []) {
    const parent = event.message.replyToMessageId
    if (!messages.has(parent) || parent === event.message.messageId) continue
    const branch = children.get(parent) ?? []
    branch.push(event); children.set(parent, branch)
  }
  const rendered = new Set()
  const renderBranch = (event, level = 0) => {
    const message = event.message
    if (rendered.has(message.messageId)) return null
    rendered.add(message.messageId)
    const person = members.find(item => item.principalId === message.author.principalId) ?? { ...message.author, displayName: t('Participant') }
    const parent = messages.get(message.replyToMessageId)
    const replies = chronological ? [] : (children.get(message.messageId) ?? []).filter(child => !rendered.has(child.message.messageId))
    const hidden = collapsed.has(message.messageId)
    return h('li', { key: message.messageId, 'data-thread-depth': level, 'data-thread-deep': level > 4 || undefined },
      h('article', { 'data-thread-message-id': message.messageId, 'data-thread-selected': message.messageId === messageId, style: { '--reply-depth': Math.min(level, 4) } },
        h('div', { className: 'bt-comm-person-label' }, members.includes(person) && onInspect ? h('button',{type:'button',className:'bt-comm-avatar-button','aria-label':t('View profile of {name}',{name:labels.get(person.principalId)??person.displayName??t('Participant')}),onClick:event=>onInspect([person.principalId],event.currentTarget)},h(CommunicationAvatar,{person,request,size:24})) : h(CommunicationAvatar, { person, request, allowed: members.includes(person), size: 24 }), h('strong', { title: person.principalId }, labels.get(person.principalId) ?? t('Participant'))),
        parent ? h('p', { className: 'bt-comm-thread-parent' }, t('Reply to'), ' ', labels.get(parent.author.principalId) ?? t('Participant'), ': ', referenceExcerpt(parent.content.text)) : null,
        h('div', { className: 'bt-comm-body' }, h(CommunicationMessage, { message, members, request, onInspect })),
        h(CommunicationMessageActions,{message,onReply:canSpeak?onReply:undefined},h('time', null, new Date(event.serverAcceptedAt).toLocaleString()),
          replies.length ? h('button', { type: 'button', 'aria-expanded': !hidden, onClick: () => setCollapsed(old => { const next = new Set(old); if (hidden) next.delete(message.messageId); else next.add(message.messageId); return next }) }, t(hidden ? 'Show {count} replies' : 'Hide replies', { count: replies.length })) : null)),
      replies.length && !hidden ? h('ol', { className: 'bt-comm-thread-branches' }, replies.map(child => renderBranch(child, level + 1))) : null)
  }
  let roots = (page?.events ?? []).filter(event => !messages.has(event.message.replyToMessageId) || event.message.replyToMessageId === event.message.messageId)
  if(chronological){
    roots=[...(page?.events??[])].sort((a,b)=>a.conversationSeq-b.conversationSeq)
  }
  return h('div', { className: 'bt-comm-thread' },
    h('p', { className: 'bt-comm-reference' }, t(canSpeak ? 'Replies stay in this conversation. Select Reply to continue an exact message.' : 'Replies stay in this conversation.')),
    page?.earlierUnavailable ? h('p', { role: 'status' }, t('Earlier context is outside your authorized history.')) : null,
    loading ? h('p', { role: 'status' }, t('Loading replies…')) : null,
    error ? h('p', { role: 'status' }, t('This reply chain is unavailable. Updates will retry automatically.')) : null,
    h('div', { className: 'bt-comm-thread-log', role: 'log', 'aria-label': t('Message replies') },
      h('ol', { className: 'bt-comm-thread-roots' }, roots.map(event => renderBranch(event)))),
    page?.hasMore ? h('button', { type: 'button', disabled: loading, onClick: () => { void more() } }, t('Load more replies')) : null)
}

// A separate persisted intent keeps an uncertain thread send independent from the
// main composer. Closing/reopening cannot silently mint a second message ID.
export function ThreadReplyComposer({ storageKey, member, target, request, onSent, attachmentsAvailable, directedReplies }) {
  const initial = () => {
    try {
      const value=JSON.parse(readCommunicationBrowserState(localStorage,storageKey))
      if(!value||typeof value!=='object'||Array.isArray(value))return {}
      if(value.attempt&&(value.attempt.conversationId!==member.conversationId||value.attempt.membershipEpoch!==member.membershipEpoch))return {}
      return value
    }catch{return {}}
  }
  const [draft, setDraft] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [completion, setCompletion] = useState(null), [index,setIndex] = useState(0)
  const input = useRef(null), composing = useRef(false), flight = useRef(false), alive = useRef(true)
  useMentionDismiss(input, Boolean(completion), () => setCompletion(null))
  useEffect(() => { alive.current=true;return () => { alive.current = false } }, [])
  const members = [...(member.info?.members ?? []), ...(member.info?.formerMembers ?? [])], labels = contactLabels(members)
  const currentTarget = draft.attempt?.replyToMessageId ?? target?.messageId
  const choices = completion ? mentionChoices(members,completion.query,t('All Bots')) : []
  const update = value => {
    const next = { ...draft, ...value }
    try { if (!saveCommunicationBrowserState(localStorage,storageKey,next)) return null; setDraft(next); return next }
    catch { setError(t('Unable to save this reply on this device. Nothing was sent.')); return null }
  }
  const submit = async () => {
    if (flight.current || busy || !currentTarget || !draft.text?.trim() && !draft.attachments?.length) return
    let attempt
    try { attempt = draft.attempt ?? { endpoint:'send',conversationId:member.conversationId,membershipEpoch:member.membershipEpoch,
      messageId:randomId(),clientCreatedAt:new Date().toISOString(),text:draft.text??'',mentions:draft.mentions??[],
      replyToMessageId:currentTarget,...(draft.attachments?.length?{attachments:draft.attachments}:{}) }
    } catch (failure) { setError(communicationFailure(failure)); return }
    if (!update({attempt,replyTarget:draft.replyTarget??{author:target.author,content:{text:referenceExcerpt(target.content?.text??'')}}})) return
    flight.current = true; setBusy(true); setError(''); setCompletion(null)
    try {
      await request(attempt)
      localStorage.removeItem(storageKey)
      if (alive.current) { setDraft({}); await onSent?.(); input.current?.focus() }
    } catch (failure) { if (alive.current) { if(!operationOutcomeUncertain(failure))update({attempt:undefined,replyTarget:undefined});setError(communicationFailure(failure)) } }
    finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  const attach = async files => {
    if (flight.current || draft.attempt || !attachmentsAvailable) return
    flight.current = true; setBusy(true); setError('')
    try { const attachments = await selectedAttachments([...files],draft.attachments??[]); if (alive.current) update({attachments}) }
    catch(failure) { if (alive.current) setError(communicationFailure(failure)) }
    finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  const complete = person => {
    const result = insertMention(draft,completion,person)
    update({text:result.text,mentions:result.mentions,manualMentions:result.manualMentions}); setCompletion(null)
    requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(result.caret,result.caret)})
  }
  const query = node => { setCompletion(mentionQuery(node.value,node.selectionStart));setIndex(0) }
  return h('div',{className:'bt-comm-thread-composer'},
    h(RecipientPreview,{member,draft:draft.attempt??draft,target:draft.replyTarget??target,request,directedReplies}),
    h('p',{className:'bt-comm-reference'},t('Reply to'),' ',labels.get((draft.replyTarget??target)?.author?.principalId)??t('Participant'),': ',referenceExcerpt((draft.replyTarget??target)?.content?.text??'')),
    choices.length?h('div',{className:'bt-comm-completion',role:'listbox','aria-label':t('Mention participant')},choices.map((person,at)=>h('button',{type:'button',key:person.principalId,role:'option','aria-selected':index===at,onMouseDown:event=>event.preventDefault(),onClick:()=>complete(person)},person.all?t('All Bots'):labels.get(person.principalId)??person.displayName))):null,
    h('textarea',{ref:input,rows:2,'aria-label':t('Reply in this thread'),value:draft.text??'',disabled:busy||Boolean(draft.attempt),
      onChange:event=>{update({text:event.target.value,mentions:retainedMentions(event.target.value,draft.mentions??[],members,draft.manualMentions??[])});if(!composing.current)query(event.target)},
      onClick:event=>query(event.target),onCompositionStart:()=>{composing.current=true;setCompletion(null)},onCompositionEnd:event=>{composing.current=false;query(event.target)},
      onKeyDown:event=>{event.stopPropagation();if(event.nativeEvent.isComposing||composing.current||event.keyCode===229)return
        if(choices.length){if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setIndex(at=>(at+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length);return}if(event.key==='Escape'){event.preventDefault();setCompletion(null);return}if(['Enter','Tab'].includes(event.key)){event.preventDefault();complete(choices[Math.min(index,choices.length-1)]);return}}
        if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void submit()}},
      onPaste:event=>{if(event.clipboardData?.files.length){event.preventDefault();event.stopPropagation();if(attachmentsAvailable)void attach(event.clipboardData.files)}},
      onDragOver:event=>{event.preventDefault();event.stopPropagation()},onDrop:event=>{event.preventDefault();event.stopPropagation();if(attachmentsAvailable)void attach(event.dataTransfer.files)}}),
    attachmentsAvailable?h('label',{className:'bt-comm-attach-picker',title:t('Attach images or files (64 KiB total)')},h(PlusIcon),h('input',{type:'file',multiple:true,disabled:busy||Boolean(draft.attempt),'aria-label':t('Attach images or files (64 KiB total)'),onChange:event=>{void attach(event.target.files);event.target.value=''}})):null,
    draft.attachments?.length?h('div',{className:'bt-comm-attachment-drafts'},draft.attachments.map((file,at)=>h('span',{key:at},file.name,h('button',{type:'button',disabled:busy||Boolean(draft.attempt),'aria-label':t('Remove {name}',{name:file.name}),onClick:()=>update({attachments:draft.attachments.filter((_,i)=>i!==at)})},h(CloseIcon))))):null,
    h('button',{type:'button',className:'bt-comm-send',disabled:busy||!currentTarget||!draft.text?.trim()&&!draft.attachments?.length,'aria-label':t(draft.attempt?'Retry same send':'Send reply'),title:t(draft.attempt?'Retry same send':'Send reply'),onClick:()=>{void submit()}},h(ArrowUpIcon),h('span',{className:'bt-sr'},t(draft.attempt?'Retry same send':'Send reply'))),
    error?h('p',{role:'alert',className:'bt-comm-thread-send-error'},error):null)
}
