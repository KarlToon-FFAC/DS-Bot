import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { install, output } from '../src/host/tools.js'

// Real public DSH services, but no model, host profile, filesystem or network.
test('real DSH assembly observes a newly repaired scoped schema in the same request and preserves restrictions', async t => {
  const ctx = new Context()
  t.after(async () => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  let result
  await ctx.plugin({ inject: ['tools', 'systemPrompt'], async apply(inner) {
    const agent = { id: 'local-session', session: { id: 'local-session' } }
    const scope = createScope(inner, agent)
    t.after(async () => scope.dispose())
    agent.ctx = scope.ctx
    const rt = { ctx: inner, state: { bots: {}, rooms: {} }, teamTools: [], load: async () => {},
      isBotSession: id => id === agent.id, roomOf: () => undefined, warn() {} }
    install(rt)
    rt.hideBotUnusedTools(agent)
    const tool = name => defineTool({ name, description: name, parameters: {}, output, execute: async () => name })
    inner.tools.register(tool('private_probe'))
    scope.ctx.tools.restrict({ deny: ['private_probe'] })
    const added = tool('publication_probe')
    rt.teamTools.push(added)
    result = await inner.systemPrompt.assemble({ scope: agent, agent })
    assert.ok(result.tools.some(schema => schema.name === added.name))
    assert.equal(result.tools.some(schema => schema.name === 'private_probe'), false)
    assert.equal(inner.tools.get(added.name, agent).description, added.description)
    assert.equal(await inner.tools.get(added.name, agent).execute({}, { agent }), added.name)
    assert.equal(rt.teamToolScopeStatus(agent.id).state, 'current')
    rt.teamTools.splice(rt.teamTools.indexOf(added), 1)
    result = await inner.systemPrompt.assemble({ scope: agent, agent })
    assert.equal(result.tools.some(schema => schema.name === added.name), false)
    assert.equal(result.tools.some(schema => schema.name === 'private_probe'), false)
  } })
  assert.ok(result)
})
