import { createElement as h } from 'react'
import { t } from './i18n.js'
import { collaborationStops, deliveryPhase } from './communication-model.js'

// Diagnostic records remain available on request, scoped to their conversation.
// Opening this view never resends, clears or rewrites the durable outbox.
export function CommunicationActivity({ state, member, events, outbox, operations, operationPending, pendingAttempt, error, pollError, friendly, labels, onRefresh, onRetry, onCopy, copyDisabled, busy }) {
  const failures = (state?.errors ?? []).filter(item => !member || item.conversationId === member.conversationId)
  const exports = (state?.exportFailures ?? []).filter(item => !member || item.conversationId === member.conversationId)
  const stops = collaborationStops(events, outbox)
  const notice = value => h('p', { role: 'status' }, t(value))
  return h('div', { className: 'bt-comm-activity' },
    member ? h('p', { className: 'bt-comm-reference' }, member.title ?? t('Private conversation')) : null,
    h('button', { type: 'button', disabled: busy, onClick: onRefresh }, t('Refresh status')),
    error ? notice(error) : null, state?.error ? notice(friendly({ code: state.error })) : null, pollError ? notice(pollError) : null,
    pendingAttempt ? h('section', null, notice('Send not confirmed. Retry the same message to avoid sending it twice.'), h('button', { type: 'button', onClick: onRetry, disabled: busy }, t('Retry same send'))) : null,
    operationPending ? notice('An operation is not confirmed. Check status, then retry the same action.') : null,
    operations.map(item => h('section', { key: item.id }, !member && item.conversationId ? h('p', { className: 'bt-comm-reference' }, item.conversationId) : null, notice(item.state === 'failed' ? 'Operation failed' : 'Operation queued'), item.error ? notice(friendly({ code: item.error })) : notice('Waiting for the Hub'))),
    outbox.filter(item => item.state !== 'accepted').map(item => h('section', { key: item.id, 'data-activity-message-id': item.id },
      !member && item.conversationId ? h('p', { className: 'bt-comm-reference' }, item.conversationId) : null, notice(item.state === 'failed' ? 'Send failed' : item.state === 'accepted' ? 'Hub accepted' : 'Queued on this device'),
      h('p', { className: 'bt-comm-pending-text' }, item.text), item.error ? notice(friendly({ code: item.error })) : null,
      item.membershipEpoch && item.membershipEpoch !== member?.membershipEpoch ? notice('This record belongs to an earlier membership.') : null,
      (item.deliveries ?? []).filter(delivery => delivery.recipientPrincipalId !== state?.humanPrincipalId).map(delivery => h('p', { key: delivery.deliveryId, className: 'bt-comm-reference' }, `${labels.get(delivery.recipientPrincipalId) ?? t('Participant')}: ${t(deliveryPhase(delivery))}`)),
      item.state === 'failed' ? h('button', { type: 'button', disabled: copyDisabled || busy, onClick: () => onCopy(item) }, t('Copy to draft')) : null)),
    stops.map(item => h('p', { key: item.messageId, role: 'status', 'data-causal-stop': item.messageId }, t('Bot collaboration stopped at the safety limit. Send a new Human message to continue.'))),
    failures.map(item => h('p', { key: item.bindingId, role: 'status' }, t('Bot delivery needs reconciliation'), ': ', item.code)),
    exports.map(item => h('p', { key: item.messageId, role: 'status' }, t('Send failed'), ': ', item.code)),
    !error && !state?.error && !pollError && !pendingAttempt && !operationPending && !operations.length && !outbox.some(item => item.state !== 'accepted') && !stops.length && !failures.length && !exports.length ? notice('No activity needs attention.') : null)
}
