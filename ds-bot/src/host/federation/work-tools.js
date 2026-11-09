import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
const MUTATING_WORK = new Set(['write', 'edit', 'str_replace_editor', 'bash', 'pwsh'])
const fail = code => { throw Object.assign(new Error(code), { code }) }

// Only these definitions may cross from the owning Bot's local tool scope.
// Credentials, local team management and other conversations remain excluded.
export const WORK_TOOL_NAMES = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'str_replace_editor'])

export async function botWorkDirectory(rt, bot) {
  const requested = rt.workDirOf?.({ botId: bot.id })
  if (requested && await rt.isFolder(requested)) return requested
  if (!rt.teamFolder?.()) await rt.ensureWorkspace?.()
  const fallback = rt.teamFolder?.()
  if (!fallback || !await rt.isFolder(fallback)) fail('COMMUNICATION_WORKSPACE_UNAVAILABLE')
  return fallback
}

export async function syncWorkTools(runtime, agent, bot) {
  if (!runtime.rt.resolveAgent || !runtime.rt.chatOf || !runtime.ctx.tools?.get) return []
  const local = await runtime.rt.resolveAgent(runtime.rt.chatOf(bot.id))
  runtime.workToolScopes ??= new WeakMap()
  let entries = runtime.workToolScopes.get(agent)
  if (!entries) {
    entries = new Map()
    runtime.workToolScopes.set(agent, entries)
    runtime.disposers.push(() => { for (const entry of entries.values()) { entry.active = false; entry.dispose() }; entries.clear() })
  }
  const registry = runtime.ctx.tools
  for (const name of WORK_TOOL_NAMES) {
    const definition = registry.get(name, local), prior = entries.get(name)
    if (prior?.definition === definition) continue
    if (prior) { prior.active = false; prior.dispose(); entries.delete(name) }
    if (!definition) continue
    const entry = { definition, active: true }
    const registered = { ...definition, async execute(args, exec) {
      args = structuredClone(args)
      const binding = runtime.owners.get(agent.id)
      if (runtime.closed || exec.agent !== agent || !binding || !entry.active) fail('COMMUNICATION_TOOL_NOT_ALLOWED')
      await runtime.authorize(binding)
      const provenance = await runtime.toolProvenance(exec)
      await runtime.syncWorkContext(agent)
      if (runtime.closed || !entry.active || entries.get(name) !== entry) fail('COMMUNICATION_TOOL_NOT_ALLOWED')
      if (args.run_in_background === true) fail('COMMUNICATION_BACKGROUND_UNAVAILABLE')
      runtime.workCalls ??= new Map()
      runtime.workControllers ??= new Map()
      const key = `${agent.id}:${exec.callId}`, controller = new AbortController()
      let finish
      const done = new Promise(resolve => { finish = resolve })
      runtime.workControllers.set(key, { controller, binding, done })
      const first = keys => keys.map(key => args[key]).find(value => typeof value === 'string' && value.trim())
      const redact = value => runtime.rt.redactSecrets?.(value) ?? value
      const command = redact(first(['command', 'file_path', 'path']) ?? '')
      runtime.workCalls.set(key, { sessionId: agent.id, text: redact(first(['description', 'justification']) ?? '').slice(0, 2000),
        code: runtime.settings?.remoteWorkApproval === 'ask' ? command : command.slice(0, 2000), workDirectory: agent.session.header?.cwd, sourceMessageId: provenance?.replyToMessageId })
      const signal = AbortSignal.any([exec.signal, controller.signal].filter(Boolean))
      try {
        if (runtime.settings?.remoteWorkApproval === 'ask' && MUTATING_WORK.has(name)) {
          const approval = runtime.ctx.get?.('approval')
          if (!approval?.request) fail('WORK_APPROVAL_UNAVAILABLE')
          const outcome = await approval.request({ agent, toolName: name, callId: exec.callId,
            reason: 'Allow this one remote write or command? This does not expand the sandbox.', signal })
          if (outcome !== 'allowed-once') fail(outcome === 'rejected' ? 'WORK_APPROVAL_REJECTED' : outcome === 'cancelled' ? 'WORK_APPROVAL_CANCELLED' : 'WORK_APPROVAL_UNAVAILABLE')
          if (signal.aborted) fail('WORK_APPROVAL_CANCELLED')
          await runtime.authorize(binding)
          await runtime.syncWorkContext(agent)
          if (signal.aborted) fail('WORK_APPROVAL_CANCELLED')
          if (runtime.closed || !entry.active || entries.get(name) !== entry) fail('COMMUNICATION_TOOL_NOT_ALLOWED')
        }
        return await definition.execute(args, { ...exec, signal })
      }
      finally { runtime.workCalls.delete(key); runtime.workControllers.delete(key); finish() }
    } }
    entry.dispose = agent.ctx.tools.register(registered)
    entries.set(name, entry)
  }
  return [...entries.keys()]
}

export function cancelRevokedWork(runtime) {
  for (const { controller, binding } of runtime.workControllers?.values() ?? []) {
    try {
      if (runtime.queue.isRetiredBot?.(binding.recipientPrincipalId)) fail('BOT_RETIRED')
      const member = runtime.queue.member(binding.conversationId, binding.recipientPrincipalId, binding.membershipEpoch)
      if (member?.body && JSON.parse(member.body).retiredPeer) fail('BOT_RETIRED')
    }
    catch { controller.abort(); for (const id of binding.sessionIds ?? []) runtime.rt.cancelApprovals?.(id) }
  }
}

export function syncWorkPermission(runtime, agent, bot) {
  const service = runtime.ctx.get?.('permissionPresets')
  if (!service) { if (runtime.settings?.remoteWorkApproval === 'ask') setApprovalPolicy(agent.session, 'ask'); return }
  const wanted = bot.permission ?? service.catalog().defaultPreset
  if (service.current(agent.session) !== wanted) service.set(agent.session, wanted)
  if (runtime.settings?.remoteWorkApproval === 'ask') setApprovalPolicy(agent.session, 'ask')
}
