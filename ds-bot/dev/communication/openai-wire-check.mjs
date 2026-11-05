// Public Pi Responses adapter -> loopback guard -> in-memory Mock; no API access.
import assert from 'node:assert/strict'
import { OpenAIBudget, OpenAITestGate, startOpenAITestGuard } from './openai-budget.mjs'

export async function checkOpenAIWire(stream) {
  const budget = new OpenAIBudget(':memory:', { maxCostMicroUsd: 100000 })
  const calls = []
  const item = { id: 'msg_mock', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Synthetic acknowledgement', annotations: [], logprobs: [] }] }
  const terminal = { id: 'resp_mock', model: 'gpt-6-luna', status: 'completed', output: [item],
    usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 } } }
  const events = [
    { type: 'response.created', response: { id: terminal.id, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Synthetic acknowledgement' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: terminal },
  ]
  const sender = {
    count: async body => { calls.push({ type: 'count', body }); return Response.json({ object: 'response.input_tokens', input_tokens: 12 }) },
    generate: async body => {
      calls.push({ type: 'generate', body })
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    },
  }
  const localToken = 'synthetic-local-token-for-offline-wire-check'
  let guard
  try {
    guard = await startOpenAITestGuard({ gate: new OpenAITestGate(budget, sender), localToken })
    const model = { id: 'gpt-6-luna', name: 'GPT-6 Luna isolated test', api: 'openai-responses', provider: 'openai',
      baseUrl: guard.url, reasoning: true, input: ['text'], contextWindow: 1050000, maxTokens: 1024,
      cost: { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.25 } }
    const result = await stream(model, { systemPrompt: 'Only synthetic communication test data.',
      messages: [{ role: 'user', content: 'Please acknowledge the synthetic message.', timestamp: 0 }],
      tools: [{ name: 'read_communication_history', description: 'Read only the bound synthetic conversation.',
        parameters: { type: 'object', properties: {}, additionalProperties: false } }] },
    { apiKey: localToken, maxTokens: 1024, cacheRetention: 'none', maxRetries: 0, transport: 'sse',
      serviceTier: 'default', timeoutMs: 10000, signal: AbortSignal.timeout(15000) }).result()
    assert.equal(result.stopReason, 'stop', result.errorMessage)
    assert.equal(result.content.filter(block => block.type === 'text').map(block => block.text).join(''), 'Synthetic acknowledgement')
    assert.deepEqual(calls.map(call => call.type), ['count', 'generate'])
    const body = calls[1].body
    assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.max_output_tokens, 1024)
    assert.equal(body.reasoning.effort, 'none'); assert.equal(body.store, false); assert.equal(body.service_tier, 'default')
    assert.deepEqual(calls[0].body.input, body.input); assert.deepEqual(calls[0].body.tools, body.tools)
    assert.equal(JSON.stringify(calls).includes(localToken), false)
    return { status: 'PASS_LOOPBACK_MOCK', officialApiRequests: 0, generations: 1, outboundSlotsReserved: budget.snapshot().requests,
      model: body.model, api: model.api, inputCount: 12, maxOutputTokens: body.max_output_tokens, reasoningEffort: body.reasoning.effort,
      stream: result.stopReason, realCredentialRead: false }
  } finally { await guard?.close(); budget.close() }
}
