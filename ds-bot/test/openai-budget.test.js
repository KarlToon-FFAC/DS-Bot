import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { OpenAIBudget, OpenAITestGate, officialOpenAISender, startOpenAITestGuard, prepareOpenAIRequest, budgetPolicy } from '../dev/communication/openai-budget.mjs'

const request = extra => ({ model: 'gpt-6-luna', input: 'Synthetic test only', ...extra })
test('the new scoped remote tools remain explicitly allowlisted while arbitrary tools stay blocked',()=>{
  for(const name of ['read_communication_members','read_communication_reference','configure_communication_group','save_communication_group_settings',
    'read_communication_attachment','read_communication_thread','set_communication_reply_targets','update_communication_handoff']){
    assert.doesNotThrow(()=>prepareOpenAIRequest(request({tools:[{type:'function',name,parameters:{type:'object',properties:{}}}]}),budgetPolicy()))
  }
  assert.throws(()=>prepareOpenAIRequest(request({tools:[{type:'function',name:'read_private_files',parameters:{}}]}),budgetPolicy()),{code:'TOOL_NOT_ALLOWED'})
})
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const fixture = (t, options = {}, extra = {}) => {
  const budget = new OpenAIBudget(':memory:', { maxCostMicroUsd: 100000, ...options }); t.after(() => budget.close())
  const calls = []
  const sender = { count: async body => { calls.push({ type: 'count', body }); return json({ object: 'response.input_tokens', input_tokens: 12 }) },
    generate: async body => { calls.push({ type: 'generate', body }); return json({ id: 'mock-response', model: body.model, output: [] }) },
    model: async () => { calls.push({ type: 'model' }); return json({ id: 'gpt-6-luna' }) }, ...extra }
  return { budget, sender, calls, gate: new OpenAITestGate(budget, sender) }
}

test('real execution and spending default closed; no credential or network is required for preparation', async t => {
  const budget = new OpenAIBudget(':memory:'); t.after(() => budget.close())
  let sent = 0
  assert.throws(() => officialOpenAISender({ credential: 'synthetic-only-key', fetchImpl: () => { sent++ } }), { code: 'REAL_EXECUTION_NOT_APPROVED' })
  await assert.rejects(new OpenAITestGate(budget, { count: () => { sent++ } }).generate(request()), { code: 'BUDGET_UNAPPROVED' })
  assert.equal(sent, 0); assert.equal(budget.snapshot().requests, 0)
})

test('exact model, tier, text-only content, no hidden server context and no hosted tool fees are enforced before reservation', async t => {
  const { gate, calls, budget } = fixture(t)
  for (const change of [
    { model: 'gpt-5.6-luna' }, { model: 'gpt6luna' }, { service_tier: 'priority' }, { store: true }, { max_output_tokens: 1025 },
    { previous_response_id: 'other-session' }, { conversation: 'private' }, { background: true }, { truncation: 'auto' },
    { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'function', name: 'read_file', parameters: {} }] }, { tool_choice: { type: 'web_search' } },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.invalid/private' }] }] },
    { input: [{ type: 'function_call_output', call_id: 'x', output: [{ type: 'input_file', file_id: 'private' }] }] },
    { prompt_cache_retention: '24h' }, { extra: 'unknown' },
  ]) await assert.rejects(gate.generate(request(change)))
  assert.equal(calls.length, 0); assert.equal(budget.snapshot().requests, 0)
})

test('token preflight uses identical model-visible input and request cap includes reasoning output', async t => {
  const { gate, calls, budget } = fixture(t, {}, { count: async body => { calls.push({ type: 'count', body }); return json({ object: 'response.input_tokens', input_tokens: 12000 }) } })
  const input = request({ input: [{ role: 'user', content: [{ type: 'input_text', text: '😀 合成测试' }] }], reasoning: { effort: 'none' },
    tools: [{ type: 'function', name: 'read_communication_history', parameters: { type: 'object', properties: {} } }] })
  const response = await gate.generate(input); assert.equal(response.status, 200)
  assert.deepEqual(calls[0].body.input, calls[1].body.input)
  assert.deepEqual(calls[0].body.tools, calls[1].body.tools)
  assert.equal(calls[1].body.max_output_tokens, 1024); assert.equal(calls[1].body.store, false); assert.equal(calls[1].body.service_tier, 'default')
  assert.equal(budget.snapshot().requests, 2); assert.equal(budget.snapshot().inputTokens, 12000); assert.equal(budget.snapshot().outputTokens, 1024)
  assert.equal(budget.snapshot().costMicroUsd, 3512)
})

test('eight total outbound slots include count calls and concurrent requests cannot exceed four generations', async t => {
  const { gate, calls, budget } = fixture(t)
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => gate.generate(request())))
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 4)
  assert.ok(outcomes.filter(item => item.status === 'rejected').every(item => item.reason.code === 'REQUEST_BUDGET_EXHAUSTED'))
  assert.equal(calls.length, 8); assert.equal(budget.snapshot().requests, 8)
  assert.equal(budget.snapshot().costMicroUsd, 14048)
})

test('oversize or unavailable counts cannot reach generation and their reserved slots are never refunded', async t => {
  for (const counted of [12001, -1, 1.2, undefined]) {
    const { gate, calls, budget } = fixture(t, {}, { count: async () => json({ object: 'response.input_tokens', input_tokens: counted }) })
    await assert.rejects(gate.generate(request()), { code: 'INPUT_BUDGET_EXCEEDED' })
    assert.equal(calls.length, 0)
    assert.equal(budget.snapshot().requests, 2)
    assert.equal(budget.snapshot().reservations[1].state, 'not_sent')
  }
  const { gate, budget } = fixture(t, {}, { count: async () => { throw new Error('synthetic count timeout') } })
  await assert.rejects(gate.generate(request()), { code: 'TOKEN_COUNT_UNAVAILABLE' })
  assert.equal(budget.snapshot().requests, 2)
})

test('unknown dispatch outcome is charged conservatively, has no retry and aggregate/token/cost ceilings stop before network', async t => {
  let attempts = 0
  const { gate, budget } = fixture(t, {}, { generate: async () => { attempts++; throw new Error('synthetic connection loss') } })
  await assert.rejects(gate.generate(request()), { code: 'UPSTREAM_REQUEST_FAILED' })
  assert.equal(attempts, 1); assert.equal(budget.snapshot().costMicroUsd, 3512)
  assert.equal(budget.snapshot().reservations[1].state, 'unknown')
  for (const [options, code] of [[{ maxTotalInputTokens: 11999 }, 'TOKEN_BUDGET_EXHAUSTED'], [{ maxTotalOutputTokens: 1023 }, 'TOKEN_BUDGET_EXHAUSTED'], [{ maxCostMicroUsd: 3511 }, 'COST_BUDGET_EXHAUSTED']]) {
    const limited = fixture(t, options)
    await assert.rejects(limited.gate.generate(request()), { code })
    assert.equal(limited.calls.length, 0); assert.equal(limited.budget.snapshot().requests, 0)
  }
})

test('cancellation between counting and generation holds the reservation without sending the generation', async t => {
  const abort = new AbortController()
  const { gate, calls, budget } = fixture(t, {}, { count: async () => {
    abort.abort()
    return json({ object: 'response.input_tokens', input_tokens: 12 })
  } })
  await assert.rejects(gate.generate(request(), abort.signal), { name: 'AbortError' })
  assert.equal(calls.length, 0); assert.equal(budget.snapshot().requests, 2)
  assert.equal(budget.snapshot().reservations[1].state, 'not_sent')
})

test('SQLite reopen and a second connection preserve reservations, forbid policy changes, and contain no prompts or credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsbot-openai-budget-')), path = join(root, 'budget.sqlite'), options = { maxCostMicroUsd: 100000 }
  let first, second
  try {
    first = new OpenAIBudget(path, options); second = new OpenAIBudget(path, options)
    const canary = 'synthetic-private-canary-not-for-ledger'
    first.reserve(request({ input: canary })); second.reserve(request()); first.close(); first = null
    first = new OpenAIBudget(path, options)
    assert.equal(first.snapshot().requests, 4)
    assert.equal(JSON.stringify(first.snapshot()).includes(canary), false)
    assert.throws(() => new OpenAIBudget(path, { maxCostMicroUsd: 99999 }), { code: 'BUDGET_POLICY_MISMATCH' })
    assert.equal(first.snapshot().requests, 4)
    assert.equal(readFileSync(path).includes(Buffer.from(canary)), false)
  } finally {
    first?.close(); second?.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('dsbot-openai-budget-'))
    rmSync(root, { recursive: true, force: true })
  }
})

test('official transport is pinned, never follows redirects and does not retry errors or substitute Luna versions', async t => {
  const seen = []
  const sender = officialOpenAISender({ credential: 'synthetic-never-real-key', execute: true, fetchImpl: async (url, options) => {
    seen.push({ url, options }); return json({ object: 'response.input_tokens', input_tokens: 8 })
  } })
  const { budget } = fixture(t)
  const gate = new OpenAITestGate(budget, sender)
  await gate.generate(request())
  assert.deepEqual(seen.map(item => item.url), ['https://api.openai.com/v1/responses/input_tokens', 'https://api.openai.com/v1/responses'])
  assert.ok(seen.every(item => item.options.redirect === 'error'))
  assert.ok(seen.every(item => JSON.parse(item.options.body).model === 'gpt-6-luna'))
  assert.equal(JSON.stringify(budget.snapshot()).includes('synthetic-never-real-key'), false)
})

test('model metadata check consumes the same outbound budget and does not claim inference permission', async t => {
  const { gate, calls, budget } = fixture(t)
  const result = await gate.modelAccess(); assert.equal(result.id, 'gpt-6-luna'); assert.match(result.verified, /inference can still be denied/)
  await gate.generate(request()); await gate.generate(request()); await gate.generate(request())
  await assert.rejects(gate.generate(request()), { code: 'REQUEST_BUDGET_EXHAUSTED' })
  assert.equal(calls.length, 7); assert.equal(budget.snapshot().requests, 7)
})

test('loopback guard authenticates, blocks extra routes and forwards Mock streaming bytes without leaking its local token upstream', async t => {
  const { budget } = fixture(t)
  const requests = []
  const mock = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
    res.setHeader('content-type', req.url.endsWith('input_tokens') ? 'application/json' : 'text/event-stream')
    res.end(req.url.endsWith('input_tokens') ? JSON.stringify({ object: 'response.input_tokens', input_tokens: 10 }) : 'data: {"type":"response.completed","synthetic":true}\n\n')
  })
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
  const upstream = officialOpenAISender({ credential: 'synthetic-upstream-only', execute: true, fetchImpl: (url, options) => fetch(`http://127.0.0.1:${mock.address().port}${new URL(url).pathname}`, options) })
  const localToken = 'local-synthetic-token-never-persisted-123'
  const guard = await startOpenAITestGuard({ gate: new OpenAITestGate(budget, upstream), localToken })
  try {
    const send = (path, auth, body = request()) => fetch(`${guard.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await send('/responses', 'wrong')).status, 400)
    assert.equal((await send('/models', localToken)).status, 400)
    assert.equal(budget.snapshot().requests, 0)
    const response = await send('/responses', localToken, request({ stream: true, input: '😀 原生合成请求' }))
    assert.match(await response.text(), /response.completed/)
    assert.equal(requests.length, 2)
    assert.ok(requests.every(item => item.auth === 'Bearer synthetic-upstream-only'))
    assert.equal(JSON.stringify(requests).includes(localToken), false)
    assert.equal(budget.snapshot().requests, 2)
  } finally {
    await guard.close(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve))
  }
})

test('invalid policies and unknown output/content extensions fail closed rather than silently changing limits', () => {
  for (const options of [{ maxRequests: 9 }, { maxOutputTokens: 2048 }, { maxCostMicroUsd: -1 }, { model: 'other' }]) assert.throws(() => budgetPolicy(options), { code: 'INVALID_POLICY' })
  assert.throws(() => prepareOpenAIRequest(request({ input: 'x'.repeat(131072) }), budgetPolicy()), { code: 'REQUEST_TOO_LARGE' })
})

test('official assistant phase is retained in preflight/history while unknown or user-supplied phases fail closed', () => {
  const item={type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Synthetic prior final'}]}
  assert.equal(prepareOpenAIRequest(request({input:[item]}),budgetPolicy()).input[0].phase,'final_answer')
  assert.throws(()=>prepareOpenAIRequest(request({input:[{...item,phase:'hidden'}]}),budgetPolicy()),{code:'INPUT_CONTENT_NOT_ALLOWED'})
  assert.throws(()=>prepareOpenAIRequest(request({input:[{...item,role:'user'}]}),budgetPolicy()),{code:'INPUT_CONTENT_NOT_ALLOWED'})
})
