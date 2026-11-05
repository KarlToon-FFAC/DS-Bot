export const OUTSIDE_CONVERSATION_TOOLS = new Set(['create_communication_group','accept_communication_invite','reclaim_communication_ownership'])

export function assertConversationToolScope(binding, name, args) {
  if (!binding) return
  if (OUTSIDE_CONVERSATION_TOOLS.has(name) || args.contactPrincipalId
    || args.conversationId !== undefined && args.conversationId !== binding.conversationId) {
    throw Object.assign(new Error('CONVERSATION_SCOPE_MISMATCH'), { code: 'CONVERSATION_SCOPE_MISMATCH' })
  }
}
