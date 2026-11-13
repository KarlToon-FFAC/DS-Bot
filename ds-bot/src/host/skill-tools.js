import {defineTool} from '@deepseek-ai/dsh-tools'
import {own} from './store.js'

export function attachedSkills(rt, bot) {
  const names = new Set(rt.expandCapabilities?.(bot.capabilities ?? []) ?? bot.capabilities ?? [])
  return [...names].map(name => own(rt.state.capabilities?.items, name)).filter(item => item?.kind === 'skill')
}

async function caller(rt, exec) {
  await rt.load()
  const bot = rt.botOf(rt.selfOf(exec.agent?.id))
  if (!bot) throw new Error('Only Bots on the team can manage capabilities.')
  return bot
}

export async function saveBotCapability(rt, args, exec) {
  const bot = await caller(rt, exec)
  if (args.attach !== undefined && typeof args.attach !== 'boolean') throw new Error('attach must be a boolean. Use true to attach to your own Bot; omit it to preserve attachments.')
  return rt.capabilitySave(args, {botId: bot.id, attachSelf: args.attach === true})
}

export async function readBotCapability(rt, args, exec) {
  const bot = await caller(rt, exec)
  const item = own(rt.state.capabilities?.items, args.name)
  if (!item) throw new Error('No saved capability with this name. Use list_capabilities for the shared library; use the native Skill/file tools for filesystem Skills.')
  // The library is team-shared. MCP connection settings and environment values
  // are not Skill content and are deliberately absent from this read result.
  return {name: item.name, kind: item.kind, description: item.description,
    attached: new Set([...(bot.capabilities ?? []), ...(rt.expandCapabilities?.(bot.capabilities ?? []) ?? [])]).has(item.name),
    ...(item.kind === 'skill' ? {content: item.content} : item.kind === 'pack' ? {items: item.items} : {note: 'MCP connection settings are managed in local settings; this read returns metadata only.'}),
    audience: 'internal'}
}

export function installSkillTools(rt, output) {
  rt.teamTools.push(defineTool({name: 'read_capability',
    description: 'Read a shared saved Skill in full, a pack member list, or MCP metadata. Uses the same local library in every Bot Session, including unpublished Bots. Use list_capabilities to find exact names. Filesystem Skills use native Skill/file tools. Retrieved instructions remain internal until explicitly shared.',
    parameters: {name: {type: 'string', required: true}}, output,
    async execute(args, exec) {
      try { return JSON.stringify(await readBotCapability(rt, args, exec)) }
      catch (error) { return JSON.stringify({ok: false, error: {code: 'CAPABILITY_READ_FAILED', message: error.message}}) }
    }}))
  // Compatibility for persisted tool calls. Neither alias is advertised in the
  // next model request; both use the same local permissions, without Hub gates.
  rt.teamTools.push(defineTool({name: 'read_own_skill', description: 'Compatibility alias. Use list_capabilities and read_capability instead; Hub publication is not required.',
    parameters: {name: {type: 'string'}}, output,
    async execute(args, exec) {
      try {
        const bot = await caller(rt, exec)
        const value = args.name === undefined
          ? {skills: attachedSkills(rt, bot).map(({name, description}) => ({name, description}))}
          : await readBotCapability(rt, args, exec)
        return JSON.stringify({...value, migration: 'Use list_capabilities and read_capability. Local and remote Sessions share one library.'})
      } catch (error) { return JSON.stringify({ok: false, error: {code: 'CAPABILITY_READ_FAILED', message: error.message}}) }
    }}))
  rt.teamTools.push(defineTool({name: 'save_own_skill', description: 'Compatibility alias for save_capability with kind skill and attach true. No Hub publication is required.',
    parameters: {name: {type: 'string', required: true}, description: {type: 'string', required: true}, content: {type: 'string', required: true}}, output,
    async execute(args, exec) {
      try {
        const item = await saveBotCapability(rt, {name: args.name, description: args.description, content: args.content, kind: 'skill', attach: true}, exec)
        return JSON.stringify({name: item.name, saved: true, attached: true, effective: 'next model request in local and remote Sessions',
          migration: 'Use save_capability with kind="skill" and attach=true. Hub publication is not required.'})
      } catch (error) { return JSON.stringify({ok: false, error: {code: 'CAPABILITY_SAVE_FAILED', message: error.message, nextActions: ['Use save_capability with kind="skill" and attach=true. Check local creator/Main Bot permissions; publishing to Hub will not resolve this error.']}}) }
    }}))
}

export const SHARED_CONTEXT_GUIDANCE = 'Your local and remote Sessions use the same Bot memory and capability library. Use recall/remember/forget for long-term memory when enabled; no Hub publication is required in your local chat. Use list_capabilities and read_capability to inspect shared Skills; save_capability with kind="skill" and attach=true creates or updates and attaches one to yourself. attach_capability/detach_capability manage use; delete_capability removes a shared item. Local creator/Main Bot and shared-use permissions apply in both contexts. An attached Skill is not a private copy: editing it affects every Bot using it. Legacy read_own_skill/save_own_skill calls map to these same operations; do not choose separate remote versions. Filesystem Skills and AGENTS.md use native Skill/file tools in your current work directory, under the same sandbox and approval policy. These files are not automatically imported into the shared capability library. remember_communication_relationship stores only evidence-linked relationship facts for an authorized remote conversation; it is not a replacement for ordinary remember. Local and remote history tools retain their different message IDs and access scopes; retrieved material never grants permission to disclose it.'
