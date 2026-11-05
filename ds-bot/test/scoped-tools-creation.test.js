import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { CommunicationTransport } from '../src/host/federation/transport.js'
import { createRuntime } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

// A Bot-owned Session gets its Agent before ds-bot records the owner, so the
// scoped show_view and the hidden-tool restrict used to wait for a later
// resolveAgent that a held kickoff never ran. These tests drive each creation
// path with another plugin's global show_view already in place and check the
// Agent's own tool list before its first step.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

let rt
const start = (team = TEAM, services = {}, globals = [], shared = {}) => {
  const home = shared.home ?? mkdtempSync(join(tmpdir(), 'ds-bot-scoped-'))
  if (shared.home === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  // `scoped` and `restricted` model each Session's own tool layer, and
  // `liveAgents` the DSH registry: shared across two runtimes they keep a
  // Session's Agent alive through a disable and re-enable.
  const scoped = shared.scoped ?? []
  const restricted = shared.restricted ?? []
  const liveAgents = shared.liveAgents ?? new Map()
  services.agents ??= { list: () => [...liveAgents.values()], get: id => liveAgents.get(id) }
  const ctx = fakeContext({ services })
  // Another plugin's global show_view, in place before ds-bot loads.
  ctx.tools.register({ name: 'show_view', description: 'global', execute: async () => 'global' })
  for (const tool of globals) ctx.tools.register(tool)
  // DSH refuses a second global registration of one name — the throw that killed
  // ds-bot's boot in #703 — so the fake refuses the same way.
  const plainRegister = ctx.tools.register.bind(ctx.tools)
  ctx.tools.register = (tool) => {
    if (ctx.registeredTools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
    return plainRegister(tool)
  }
  let sessions = 0
  const agentOf = (sessionId) => {
    const held = liveAgents.get(sessionId)
    if (held !== undefined) return held
    const nextStep = []
    const nextTurn = []
    const agent = {
      id: sessionId,
      session: { id: sessionId, header: { cwd: '/team' }, requestHeader: () => undefined, deriveMessages: () => [] },
      ctx: {
        tools: {
          register: (tool) => {
            if (scoped.some(entry => entry.sessionId === sessionId && entry.name === tool.name)) throw new Error('DUPLICATE_SCOPE_TOOL')
            const entry = { sessionId, name: tool.name, tool }
            scoped.push(entry)
            // DSH's disposer unregisters; the fake drops the record.
            return () => { const at = scoped.indexOf(entry); if (at !== -1) scoped.splice(at, 1) }
          },
          restrict: (filter) => {
            const entry = { sessionId, deny: filter.deny ?? [] }
            restricted.push(entry)
            return () => { const at = restricted.indexOf(entry); if (at !== -1) restricted.splice(at, 1) }
          },
        },
        effect: execute => (typeof execute === 'function' ? execute() : undefined),
        on: () => () => {},
      },
      status: 'idle',
      followup() {},
      steer() {},
      inject() {},
      send(message, target) {
        ;(target === 'next-turn' ? nextTurn : nextStep).push(message)
      },
      cancel() {},
      async whenIdle() {},
      async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
      inbox: {
        nextStep,
        nextTurn,
        prepend(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).unshift(message) },
        append(target, message) { ;(target === 'next-turn' ? nextTurn : nextStep).push(message) },
        remove(id) {
          for (const list of [nextStep, nextTurn]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      },
    }
    liveAgents.set(sessionId, agent)
    return agent
  }
  // ask_user_question is served, so the deny list is not empty in a Bot scope.
  ctx.tools.schemas = () => [{ name: 'ask_user_question' }, { name: 'show_view' }]
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id: 'w1', path: '/team' } : undefined),
      list: () => [{ id: 'w1', path: '/team' }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  rt = createRuntime(ctx, { home, ...shared.config })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, data })
    }
  }
  const agentCreated = async (sessionId) => {
    for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent: agentOf(sessionId) })
  }
  const tool = (name, args, sessionId, exec = {}) =>
    rt.teamTools.find(d => d.name === name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1', ...exec })
  const unload = () => ctx.dispose()
  const stop = async () => {
    await unload()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { runtime: rt, ctx, call, tool, emit, agentCreated, agentOf, scoped, restricted, home, unload, stop }
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const hasShowView = (host, id) => host.scoped.some(entry => entry.sessionId === id && entry.name === 'show_view')
const denied = (host, id) => host.restricted.some(entry => entry.sessionId === id && entry.deny.includes('ask_user_question'))
const scopedNames = (host, id) => host.scoped.filter(entry => entry.sessionId === id).map(entry => entry.name)

test('a Bot Session gets every team tool in its own scope', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  assert.deepEqual(scopedNames(host, 'a').sort(), [...TEAM_TOOLS].filter(name => name !== 'read_browser').sort())
})

test('a Session ds-bot does not own sees none of the team tools', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('plain1')
  assert.deepEqual(scopedNames(host, 'plain1'), [])
  // Nothing of the team's reaches the global layer a plain session reads; the
  // only team-named global is another plugin's show_view.
  const leaked = [...host.ctx.registeredTools.keys()].filter(name => TEAM_TOOLS.includes(name))
  assert.deepEqual(leaked, ['show_view'])
  assert.equal(host.ctx.registeredTools.get('show_view').description, 'global')
})

test("a group's own Session is scoped to group_relay alone", async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('r1')
  assert.deepEqual(scopedNames(host, 'r1'), ['group_relay'])
})

test("another plugin's global recall cannot stop ds-bot or shadow its own", async (t) => {
  // #703: a same-named global tool from another plugin must not fail apply(),
  // and inside a Bot Session ds-bot's recall still wins.
  const host = start(TEAM, {}, [{ name: 'recall', description: 'foreign recall', execute: async () => 'foreign' }])
  t.after(host.stop)
  assert.equal(host.ctx.registeredTools.get('recall').description, 'foreign recall')
  await host.call('state', {})
  await host.agentCreated('a')
  const recall = host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'recall')
  assert.match(String(recall?.tool?.description), /^Search your memory/)
})

test('a Bot made without a model has the scoped tools before its first step', async (t) => {
  const host = start({ ...TEAM, rooms: {} })
  t.after(host.stop)
  const created = await host.call('create-bot', { name: 'Solo' })
  assert.equal(created.ok, true)
  const id = created.value.id
  assert.ok(hasShowView(host, id), 'the Bot scope has ds-bot\'s show_view over the global one')
  assert.ok(denied(host, id), 'the blocking question tool is denied')
})

test('a group Session made for a member has the scoped tools before its first step', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  const stop = new AbortController()
  t.after(() => stop.abort())
  // The user's post starts a round; Writer has no group Session yet, so the round
  // makes one — which used to keep whatever tools a global registration left.
  host.emit('r1', 'user/message', { content: [{ type: 'text', text: 'launch moved' }], source: { kind: 'user' } })
  void host.tool('group_relay', {}, 'r1', { callId: 'r1', signal: stop.signal }).catch(() => {})
  await until(() => hasShowView(host, 's1'), 5000)
  assert.ok(denied(host, 's1'), 'the blocking question tool is denied in the group scope')
})

test('a fresh part Session has the scoped tools before its first step', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'ds-bot-scoped-proj-'))
  const host = start({ ...TEAM, rooms: {} }, {
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { request: async () => 'allowed-once' },
  })
  t.after(async () => {
    await host.stop()
    rmSync(project, { recursive: true, force: true, maxRetries: 5 })
  })
  await host.call('state', {})
  host.agentOf('b').status = 'running'
  const moved = await host.tool('update_bot', { work_dir: project }, 'b')
  assert.equal(String(moved).includes('From your next step on'), true)
  // The next step sees the folder change and switches to a fresh part.
  const preStep = host.ctx.listeners.get('agent/pre-step').at(-1)
  const answer = await preStep(
    { agent: host.agentOf('b'), messages: [{ role: 'user', content: [{ type: 'text', text: 'go on' }], source: { kind: 'user' } }], step: 2, signal: AbortSignal.timeout(60_000) },
    async () => 'next',
  )
  assert.deepEqual(answer, { kind: 'reject' })
  await until(() => hasShowView(host, 's1'), 5000)
  assert.ok(denied(host, 's1'), 'the blocking question tool is denied in the fresh part')
})

test('a Session ds-bot does not own keeps only the global show_view', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('plain1')
  assert.ok(!hasShowView(host, 'plain1'), 'no scoped show_view shadows the global one')
  assert.ok(!host.restricted.some(entry => entry.sessionId === 'plain1'), 'no restrict applies outside the team')
})

test("a deleted Bot's Session keeps none of the scope when it is adopted as a plain one", async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('b')
  assert.ok(hasShowView(host, 'b'))
  assert.ok(denied(host, 'b'))
  assert.equal((await host.call('delete-bot', { id: 'b' })).ok, true)
  assert.deepEqual(scopedNames(host, 'b'), [])
  assert.equal(host.restricted.some(entry => entry.sessionId === 'b'), false)
  // The Session lives on unowned: adopting it into the DSH Agent must not bring
  // the team tools back.
  const agent = (await host.call('add-agent', {})).value
  assert.equal((await host.call('agent-adopt', { agentId: agent.id, sessionId: 'b' })).ok, true)
  assert.deepEqual(scopedNames(host, 'b'), [])
  assert.equal(host.restricted.some(entry => entry.sessionId === 'b'), false)
})

test('a member who leaves the group loses the scoped tools', async (t) => {
  const team = {
    ...TEAM,
    bots: { ...TEAM.bots, c: { id: 'c', name: 'Scout', role: 'Scout', sessionId: 'c', createdAt: 3 } },
    rooms: { r1: { ...TEAM.rooms.r1, members: ['a', 'b', 'c'], sessions: { b: 'sb' } } },
  }
  const host = start(team)
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('sb')
  assert.ok(hasShowView(host, 'sb'))
  assert.ok(denied(host, 'sb'))
  assert.equal((await host.call('update-room', { id: 'r1', remove: ['b'] })).ok, true)
  assert.deepEqual(scopedNames(host, 'sb'), [])
  assert.equal(host.restricted.some(entry => entry.sessionId === 'sb'), false)
  // Resolving the archived Session again does not bring the tools back.
  await host.agentCreated('sb')
  assert.deepEqual(scopedNames(host, 'sb'), [])
})

test('a deleted group loses its relay scope', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('r1')
  assert.deepEqual(scopedNames(host, 'r1'), ['group_relay'])
  assert.equal((await host.call('delete-room', { id: 'r1' })).ok, true)
  assert.deepEqual(scopedNames(host, 'r1'), [])
})

test('a Session that becomes a Bot\'s again gets the scope back', async (t) => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('b')
  assert.ok(hasShowView(host, 'b'))
  assert.equal((await host.call('delete-bot', { id: 'b' })).ok, true)
  assert.deepEqual(scopedNames(host, 'b'), [])
  // A Bot record naming the Session again — here written directly, the way an
  // adopted state could carry it — serves the tools again.
  rt.state.bots.b = { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 }
  await rt.save()
  await host.agentCreated('b')
  assert.ok(hasShowView(host, 'b'))
})

test('a live Bot Session gets its team tools back after a disable and re-enable', async (t) => {
  // A hot reload lifts the scope of Agents that are still live, and
  // agent/created does not fire again: the sync at the next load must scope
  // them before their next request.
  const shared = { scoped: [], restricted: [], liveAgents: new Map() }
  const first = start(TEAM, {}, [], shared)
  shared.home = first.home
  t.after(first.unload)
  await first.call('state', {})
  await first.agentCreated('a')
  assert.ok(hasShowView(first, 'a'))
  assert.ok(denied(first, 'a'))
  await first.unload()
  assert.deepEqual(scopedNames(first, 'a'), [])
  assert.equal(denied(first, 'a'), false)
  const second = start(TEAM, {}, [], shared)
  t.after(second.stop)
  await second.call('state', {})
  assert.ok(hasShowView(second, 'a'), 'the scoped team tools are back')
  assert.ok(denied(second, 'a'), 'the blocking question tool is denied again')
})

test('the same live Session reconciles added, replaced and withdrawn tool definitions without rebuilding unrelated scopes', async t => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const stable = host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'show_view')
  let finish
  const first = { name: 'publication_probe', execute: () => new Promise(resolve => { finish = resolve }) }
  host.runtime.teamTools.push(first)
  host.runtime.syncScopedTools()
  const entry = host.scoped.find(entry => entry.sessionId === 'a' && entry.name === first.name)
  assert.equal(entry.tool.name, first.name)
  const executing = entry.tool.execute({}, { agent: host.agentOf('a') })
  const replacement = { ...first, execute: async () => 'new-definition' }
  host.runtime.teamTools[host.runtime.teamTools.indexOf(first)] = replacement
  const assemble = host.ctx.listeners.get('system-prompt/assemble')[0]
  assert.equal(await assemble({}, { agent: host.agentOf('a') }, async () => 'assembled'), 'assembled')
  assert.equal(await host.scoped.find(entry => entry.sessionId === 'a' && entry.name === first.name).tool.execute({}, { agent: host.agentOf('a') }), 'new-definition')
  assert.equal(host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'show_view'), stable)
  finish('already-started-definition')
  assert.equal(await executing, 'already-started-definition', 'an already dispatched call retains its definition')
  host.runtime.teamTools.splice(host.runtime.teamTools.indexOf(replacement), 1)
  host.runtime.syncScopedTools()
  assert.equal(host.scoped.some(entry => entry.sessionId === 'a' && entry.name === first.name), false)
  assert.equal(host.runtime.teamToolScopeStatus('a').lastReloadAt, null)
})

test('a temporary scoped registration conflict retries only missing tools at the next assembly', async t => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const agent = host.agentOf('a'), register = agent.ctx.tools.register
  const stable = host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'show_view')
  let reject = true
  agent.ctx.tools.register = definition => {
    if (definition.name === 'publication_probe' && reject) throw Error('SYNTHETIC_CONFLICT')
    return register(definition)
  }
  const definition = { name: 'publication_probe', execute: async () => 'available' }
  host.runtime.teamTools.push(definition)
  host.runtime.syncScopedTools()
  assert.equal(host.runtime.teamToolScopeStatus('a').state, 'partial')
  assert.deepEqual(host.runtime.teamToolScopeStatus('a').failedNames, ['publication_probe'])
  reject = false
  await host.ctx.listeners.get('system-prompt/assemble')[0]({}, { agent }, async () => ({}))
  assert.equal(host.runtime.teamToolScopeStatus('a').state, 'current')
  assert.equal(await host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'publication_probe').tool.execute({}, { agent }), 'available')
  assert.equal(host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'show_view'), stable)
})

test('a removed registry entry is repaired from its owned definition without touching a foreign registration', async t => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  host.ctx.tools.get = (name, agent) => host.scoped.find(entry => entry.sessionId === agent.id && entry.name === name)?.tool
  const prior = host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'communication_diagnose')
  host.scoped.splice(host.scoped.indexOf(prior), 1)
  host.runtime.syncScopedTools()
  assert.equal(host.scoped.filter(entry => entry.sessionId === 'a' && entry.name === prior.name).length, 1)
  assert.deepEqual(host.scoped.find(entry => entry.sessionId === 'a' && entry.name === prior.name).tool.parameters, prior.tool.parameters)
  const restored = host.scoped.find(entry => entry.sessionId === 'a' && entry.name === prior.name)
  host.scoped.splice(host.scoped.indexOf(restored), 1)
  const foreign = { ...prior.tool, description: 'foreign owner', execute: async () => 'foreign' }
  const disposeForeign = host.agentOf('a').ctx.tools.register(foreign)
  t.after(disposeForeign)
  host.runtime.syncScopedTools()
  assert.equal(host.scoped.find(entry => entry.sessionId === 'a' && entry.name === prior.name).tool, foreign)
  assert.equal(host.runtime.teamToolScopeStatus('a').state, 'partial', 'the foreign registration is retained, never stolen')
})

test('publication reload restores new communication definitions in the same live Session after overlapping old scopes clear', async t => {
  const shared = { scoped: [], restricted: [], liveAgents: new Map(), config: { communication: { enabled: true, publishedBotIds: [] } } }
  const first = start(TEAM, {}, [], shared)
  shared.home = first.home
  t.after(first.unload)
  await first.call('state', {})
  await first.agentCreated('a')
  const oldSend = first.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'send_contact_message').tool
  shared.config = { communication: { enabled: true, publishedBotIds: ['a'] } }
  const second = start(TEAM, {}, [], shared)
  t.after(second.stop)
  await second.call('state', {})
  assert.equal(second.runtime.teamToolScopeStatus('a').state, 'partial', 'a still-owned old definition cannot be stolen')
  await first.unload()
  second.runtime.syncScopedTools()
  const freshSend = second.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'send_contact_message').tool
  assert.notEqual(freshSend, oldSend)
  assert.equal(second.runtime.teamToolScopeStatus('a').state, 'current')
  first.runtime.syncScopedTools()
  first.runtime.hideBotUnusedTools(first.agentOf('a'))
  assert.equal(first.runtime.teamToolScopeStatus('a').state, 'stopped')
  assert.equal(second.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'send_contact_message').tool, freshSend)
  assert.equal(second.runtime.config.communication.publishedBotIds.includes('a'), true)
})

test('an old runtime finishing an awaited load after unload cannot revive its Session scopes', async t => {
  const shared = { scoped: [], restricted: [], liveAgents: new Map() }
  const first = start(TEAM, {}, [], shared)
  shared.home = first.home
  t.after(first.unload)
  await first.call('state', {})
  await first.agentCreated('a')
  const originalLoad = first.runtime.load
  let release
  first.runtime.load = () => new Promise(resolve => { release = resolve })
  const pending = first.agentCreated('a')
  await new Promise(resolve => setImmediate(resolve))
  await first.unload()
  const second = start(TEAM, {}, [], shared)
  t.after(second.stop)
  await second.call('state', {})
  first.runtime.load = originalLoad
  release()
  await pending
  const own = second.runtime.teamTools.find(definition => definition.name === 'show_view')
  assert.equal(second.scoped.filter(entry => entry.sessionId === 'a' && entry.name === 'show_view').length, 1)
  assert.equal(second.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'show_view').tool.description, own.description)
  assert.equal(first.runtime.teamToolScopeStatus('a').state, 'stopped')
})

test('a Session claimed by the isolated communication runtime loses local scopes and never gets them from refresh', async t => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  host.runtime.communication = { owners: new Map([['a', {}]]) }
  host.runtime.syncScopedTools()
  assert.deepEqual(scopedNames(host, 'a'), [])
  const remote = { name: 'remote_conversation_only', execute: async () => 'scoped' }
  const dispose = host.agentOf('a').ctx.tools.register(remote)
  t.after(dispose)
  host.runtime.syncScopedTools()
  assert.deepEqual(scopedNames(host, 'a'), ['remote_conversation_only'])
  assert.equal(host.runtime.teamToolScopeStatus('a').state, 'unscoped')
})

test('a repaired scope rebuilds the current model assembly through the public API and preserves native/PTC filtering', async t => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const refresh = host.ctx.listeners.get('system-prompt/assemble').find(listener => listener.name === 'refreshBotToolAssembly')
  const context = { agent: host.agentOf('a') }
  let calls = 0, ptc = false
  host.ctx.systemPrompt.assemble = async input => {
    calls++
    assert.equal(input, context)
    const assembly = { sections: [{ name: 'preserved-filter' }], tools: ptc ? [{ name: 'run_code' }]
      : host.scoped.filter(entry => entry.sessionId === 'a').map(entry => ({ name: entry.name })) }
    return refresh(assembly, input, async () => assembly)
  }
  const definition = { name: 'publication_probe', execute: async () => 'available' }
  host.runtime.teamTools.push(definition)
  const stale = { tools: [], sections: [] }
  const current = await refresh(stale, context, async () => stale)
  assert.equal(calls, 1)
  assert.ok(current.tools.some(tool => tool.name === definition.name), 'this request sees the repaired schema, not just the next request')
  assert.deepEqual(current.sections, [{ name: 'preserved-filter' }])
  host.runtime.teamTools.splice(host.runtime.teamTools.indexOf(definition), 1)
  ptc = true
  const rebuilt = await refresh(current, context, async () => current)
  assert.equal(calls, 2)
  assert.deepEqual(rebuilt.tools, [{ name: 'run_code' }], 'registry capabilities never bypass the host transport mode')
  assert.equal(host.scoped.some(entry => entry.sessionId === 'a' && entry.name === definition.name), false)
})

test('reassembly is bounded when a conflicting tool remains unavailable', async t => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const refresh = host.ctx.listeners.get('system-prompt/assemble').find(listener => listener.name === 'refreshBotToolAssembly')
  const agent = host.agentOf('a'), register = agent.ctx.tools.register
  agent.ctx.tools.register = definition => { if (definition.name === 'unavailable_probe') throw Error('SYNTHETIC_CONFLICT'); return register(definition) }
  host.runtime.teamTools.push({ name: 'unavailable_probe', execute: async () => 'unavailable' })
  let calls = 0
  const assembly = { tools: [], sections: [] }, context = { agent }
  host.ctx.systemPrompt.assemble = async input => { calls++; return refresh(assembly, { ...input }, async () => assembly) }
  assert.equal(await refresh(assembly, context, async () => assembly), assembly)
  assert.equal(calls, 1)
  assert.equal(host.runtime.teamToolScopeStatus('a').state, 'partial')
  assert.deepEqual(host.runtime.teamToolScopeStatus('a').failedNames, ['unavailable_probe'])
})

test('an interrupted disposer leaves a withdrawn tool blocked and retries cleanup without rejecting the request', async t => {
  const host = start()
  t.after(host.stop)
  await host.call('state', {})
  await host.agentCreated('a')
  const agent = host.agentOf('a'), register = agent.ctx.tools.register
  let reject = true
  agent.ctx.tools.register = definition => {
    const dispose = register(definition)
    return () => { if (definition.name === 'withdrawn_probe' && reject) throw Error('SYNTHETIC_CLEANUP_FAILURE'); dispose() }
  }
  const definition = { name: 'withdrawn_probe', execute: async () => 'old' }
  host.runtime.teamTools.push(definition)
  host.runtime.syncScopedTools()
  host.runtime.teamTools.splice(host.runtime.teamTools.indexOf(definition), 1)
  host.runtime.syncScopedTools()
  assert.equal(host.runtime.teamToolScopeStatus('a').state, 'partial')
  assert.ok(host.ctx.guards.some(guard => guard({ agent, name: definition.name })), 'stale execution is denied while cleanup is uncertain')
  const refresh = host.ctx.listeners.get('system-prompt/assemble').find(listener => listener.name === 'refreshBotToolAssembly')
  assert.equal(await refresh({}, { agent }, async () => 'accepted'), 'accepted')
  reject = false
  host.runtime.syncScopedTools()
  assert.equal(host.scoped.some(entry => entry.sessionId === 'a' && entry.name === definition.name), false)
  assert.equal(host.runtime.teamToolScopeStatus('a').state, 'current')
})

test('publication and withdrawal reload the same live chat while the real runtime still enforces the executing Bot gate', async t => {
  const key = `DSBOT_COMMUNICATION_SCOPE_${randomUUID().replaceAll('-', '').toUpperCase()}`
  const startTransport = CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start = () => {}
  t.after(() => { CommunicationTransport.prototype.start = startTransport; delete process.env[key] })
  process.env[key] = 'synthetic-owned-scope-bootstrap'.repeat(2)
  const preset = { list: async () => [], register: async () => () => {}, serviceFor: () => undefined }
  const config = ids => ({ communication: { enabled: true, publishedBotIds: ids, url: 'ws://127.0.0.1:3190/communication', credentialEnv: key } })
  const shared = { scoped: [], restricted: [], liveAgents: new Map(), config: config([]) }
  const first = start(TEAM, { agentPresets: preset }, [], shared)
  shared.home = first.home
  t.after(first.unload)
  await first.call('state', {})
  await first.agentCreated('a')
  const denied = JSON.parse(await first.tool('list_contacts', {}, 'a'))
  assert.equal(denied.error.code, 'BOT_NOT_PUBLISHED')
  assert.equal(denied.error.subject.localBotId, 'a')
  const sameAgent = first.agentOf('a')
  await first.unload()
  shared.config = config(['a'])
  const second = start(TEAM, { agentPresets: preset }, [], shared)
  t.after(second.unload)
  await second.call('state', {})
  const offline = JSON.parse(await second.tool('list_contacts', {}, 'a'))
  assert.equal(offline.error.code, 'CONNECTION_LOST', 'publication passes the actor gate but grants no connection or consent')
  assert.equal(second.runtime.communication.actorForSession('a').localRef, 'a')
  assert.equal(second.agentOf('a'), sameAgent)
  await second.unload()
  shared.config = config([])
  const third = start(TEAM, { agentPresets: preset }, [], shared)
  t.after(third.stop)
  await third.call('state', {})
  const withdrawn = JSON.parse(await third.tool('list_contacts', {}, 'a'))
  assert.equal(withdrawn.error.code, 'BOT_NOT_PUBLISHED')
  assert.equal(third.agentOf('a'), sameAgent)
  assert.ok(third.scoped.some(entry => entry.sessionId === 'a' && entry.name === 'send_contact_message'), JSON.stringify({ status: third.runtime.teamToolScopeStatus('a'), names: scopedNames(third, 'a'), botSession: third.runtime.isBotSession('a'), count: third.runtime.teamTools.length }))
  assert.equal(third.runtime.teamToolScopeStatus('a').state, 'current')
})

test('failed cleanup after ownership removal or unload cannot execute an old team definition even without its guard', async t => {
  const host = start()
  t.after(host.stop)
  const agent = host.agentOf('a'), register = agent.ctx.tools.register
  let reject = true
  agent.ctx.tools.register = definition => {
    const dispose = register(definition)
    return () => { if (definition.name === 'list_bots' && reject) throw Error('SYNTHETIC_UNSCOPE_FAILURE'); dispose() }
  }
  await host.call('state', {})
  await host.agentCreated('a')
  const old = host.scoped.find(entry => entry.sessionId === 'a' && entry.name === 'list_bots').tool
  delete host.runtime.state.bots.a
  await host.runtime.save()
  assert.equal(host.runtime.teamToolScopeStatus('a').state, 'retired')
  host.ctx.guards.splice(0)
  await assert.rejects(old.execute({}, { agent }), { code: 'BOT_TOOL_SCOPE_EXPIRED' })
  await host.unload()
  await assert.rejects(old.execute({}, { agent }), { code: 'BOT_TOOL_SCOPE_EXPIRED' })
  reject = false
})
