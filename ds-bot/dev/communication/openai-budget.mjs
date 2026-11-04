// Test-only exit guard. Never loaded by the production plugin or ordinary benches.
import { DatabaseSync } from 'node:sqlite'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const OPENAI_MODEL = 'gpt-6-luna'
export const OPENAI_ORIGIN = 'https://api.openai.com'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (value, code) => { if (!value) fail(code) }
const digest = value => createHash('sha256').update(value).digest('hex')
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum
const MODEL_TOOLS = new Set(['list_contacts','list_communication_conversations','send_contact_message','read_communication_history',
  'invite_communication_member','leave_communication_group','remove_communication_member','set_communication_receiving_rule',
  'end_communication_group','set_communication_member_policy','transfer_communication_ownership',
  'read_communication_members','read_communication_reference','configure_communication_group'])

export function budgetPolicy(options = {}) {
  const policy = { model: OPENAI_MODEL, origin: OPENAI_ORIGIN, serviceTier: 'default', maxRequests: options.maxRequests ?? 8,
    maxInputTokens: options.maxInputTokens ?? 12000, maxOutputTokens: options.maxOutputTokens ?? 1024,
    maxTotalInputTokens: options.maxTotalInputTokens ?? 96000, maxTotalOutputTokens: options.maxTotalOutputTokens ?? 8192,
    maxCostMicroUsd: options.maxCostMicroUsd ?? 0,
    // Highest published Standard input category, including 12h cache writes.
    inputMicroUsdPerMillion: 250000, outputMicroUsdPerMillion: 500000, pricesVerifiedAt: '2026-11-03' }
  check(Object.keys(options).every(key => ['maxRequests','maxInputTokens','maxOutputTokens','maxTotalInputTokens','maxTotalOutputTokens','maxCostMicroUsd'].includes(key)), 'INVALID_POLICY')
  check(integer(policy.maxRequests, 1, 8) && integer(policy.maxInputTokens, 1, 12000) && integer(policy.maxOutputTokens, 16, 1024)
    && integer(policy.maxTotalInputTokens, 1, 96000) && integer(policy.maxTotalOutputTokens, 16, 8192)
    && integer(policy.maxCostMicroUsd, 0, 100000), 'INVALID_POLICY')
  return Object.freeze(policy)
}

export class OpenAIBudget {
  constructor(path, options = {}) {
    this.policy = budgetPolicy(options)
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      check(this.db.prepare('PRAGMA user_version').get().user_version <= 1, 'BUDGET_SCHEMA_UNSUPPORTED')
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cost_micro_usd INTEGER NOT NULL,state TEXT NOT NULL);
        PRAGMA user_version=1;`)
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const body = JSON.stringify(this.policy), existing = this.db.prepare('SELECT body FROM policy WHERE id=1').get()
        check(!existing || existing.body === body, 'BUDGET_POLICY_MISMATCH')
        this.db.prepare('INSERT OR IGNORE INTO policy VALUES (1,?)').run(body)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } catch (error) { this.db.close(); throw error }
  }
  close() { this.db.close() }
  snapshot() {
    const row = this.db.prepare(`SELECT count(*) requests,coalesce(sum(input_tokens),0) inputTokens,
      coalesce(sum(output_tokens),0) outputTokens,coalesce(sum(cost_micro_usd),0) costMicroUsd FROM reservations`).get()
    return { ...row, policy: this.policy, reservations: this.db.prepare('SELECT * FROM reservations ORDER BY id').all() }
  }
  reserve(body, { metadata = false } = {}) {
    check(this.policy.maxCostMicroUsd > 0, 'BUDGET_UNAPPROVED')
    const input = metadata ? 0 : this.policy.maxInputTokens, output = metadata ? 0 : this.policy.maxOutputTokens
    const cost = Math.ceil((input * this.policy.inputMicroUsdPerMillion + output * this.policy.outputMicroUsdPerMillion) / 1000000)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const used = this.snapshot()
      check(used.requests + (metadata ? 1 : 2) <= this.policy.maxRequests, 'REQUEST_BUDGET_EXHAUSTED')
      check(used.inputTokens + input <= this.policy.maxTotalInputTokens && used.outputTokens + output <= this.policy.maxTotalOutputTokens, 'TOKEN_BUDGET_EXHAUSTED')
      check(used.costMicroUsd + cost <= this.policy.maxCostMicroUsd, 'COST_BUDGET_EXHAUSTED')
      const insert = this.db.prepare("INSERT INTO reservations(kind,payload_hash,input_tokens,output_tokens,cost_micro_usd,state) VALUES (?,?,?,?,?,'reserved')")
      const hash = digest(JSON.stringify(body))
      const count = Number(insert.run(metadata ? 'model-access' : 'input-count', hash, 0, 0, 0).lastInsertRowid)
      const generation = metadata ? null : Number(insert.run('generation', hash, input, output, cost).lastInsertRowid)
      this.db.exec('COMMIT')
      return { count, generation }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  mark(id, state) {
    check(['started','headers','failed','unknown','not_sent'].includes(state), 'INVALID_BUDGET_STATE')
    this.db.prepare('UPDATE reservations SET state=? WHERE id=?').run(state, id)
  }
}

export function prepareOpenAIRequest(input, policy) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST')
  const fields = new Set(['model','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','stream','store',
    'max_output_tokens','service_tier','truncation','include','prompt_cache_key','prompt_cache_retention'])
  check(Object.keys(input).every(key => fields.has(key)), 'UNSUPPORTED_REQUEST_FIELD')
  check(input.model === policy.model, 'MODEL_NOT_ALLOWED')
  check(input.service_tier === undefined || input.service_tier === 'default', 'SERVICE_TIER_NOT_ALLOWED')
  check(input.store === undefined || input.store === false, 'REMOTE_STORAGE_NOT_ALLOWED')
  check(input.truncation === undefined || input.truncation === 'disabled', 'TRUNCATION_NOT_ALLOWED')
  check(input.max_output_tokens === undefined || integer(input.max_output_tokens, 16, policy.maxOutputTokens), 'OUTPUT_BUDGET_EXCEEDED')
  check(input.prompt_cache_retention === undefined || input.prompt_cache_retention === 'in_memory', 'CACHE_POLICY_NOT_ALLOWED')
  check(input.reasoning === undefined || input.reasoning && Object.keys(input.reasoning).every(key => ['effort','summary'].includes(key))
    && ['none','low','medium','high','xhigh','max'].includes(input.reasoning.effort)
    && (input.reasoning.summary === undefined || ['auto','concise','detailed'].includes(input.reasoning.summary)), 'INVALID_REASONING')
  check(input.include === undefined || Array.isArray(input.include) && input.include.every(value => value === 'reasoning.encrypted_content'), 'UNSUPPORTED_INCLUDE')
  check(input.tools === undefined || Array.isArray(input.tools) && input.tools.every(tool => tool.type === 'function' && MODEL_TOOLS.has(tool.name)
    && Object.keys(tool).every(key => ['type','name','description','parameters','strict'].includes(key))), 'TOOL_NOT_ALLOWED')
  check(input.tool_choice === undefined || ['auto','none','required'].includes(input.tool_choice)
    || input.tool_choice?.type === 'function' && MODEL_TOOLS.has(input.tool_choice.name)
      && Object.keys(input.tool_choice).every(key => ['type','name'].includes(key)), 'TOOL_NOT_ALLOWED')
  check(input.instructions === undefined || typeof input.instructions === 'string', 'UNSUPPORTED_INPUT')
  check(input.stream === undefined || typeof input.stream === 'boolean', 'INVALID_REQUEST')
  check(input.parallel_tool_calls === undefined || typeof input.parallel_tool_calls === 'boolean', 'INVALID_REQUEST')
  check(typeof input.input === 'string' || Array.isArray(input.input), 'UNSUPPORTED_INPUT')
  const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key))
  const scan = item => {
    check(item && typeof item === 'object' && !Array.isArray(item), 'INPUT_CONTENT_NOT_ALLOWED')
    if (item.type === undefined || item.type === 'message') {
      check(keys(item,['type','id','role','content','status','phase']) && ['system','developer','user','assistant'].includes(item.role)
        && (item.phase === undefined || item.phase === null || item.role === 'assistant' && ['commentary','final_answer'].includes(item.phase)), 'INPUT_CONTENT_NOT_ALLOWED')
      check(typeof item.content === 'string' || Array.isArray(item.content) && item.content.every(block =>
        keys(block,['type','text','annotations','logprobs']) && ['input_text','output_text'].includes(block.type) && typeof block.text === 'string'
        && (block.annotations === undefined || Array.isArray(block.annotations) && block.annotations.length === 0)
        && (block.logprobs === undefined || Array.isArray(block.logprobs) && block.logprobs.length === 0)), 'INPUT_CONTENT_NOT_ALLOWED')
    } else if (item.type === 'function_call') {
      check(keys(item,['type','id','call_id','name','arguments','status']) && MODEL_TOOLS.has(item.name) && typeof item.arguments === 'string', 'TOOL_NOT_ALLOWED')
    } else if (item.type === 'function_call_output') {
      check(keys(item,['type','id','call_id','output','status']) && typeof item.output === 'string', 'INPUT_CONTENT_NOT_ALLOWED')
    } else if (item.type === 'reasoning') {
      check(keys(item,['type','id','summary','encrypted_content','status']) && Array.isArray(item.summary)
        && item.summary.every(block => keys(block,['type','text']) && block.type === 'summary_text' && typeof block.text === 'string')
        && (item.encrypted_content === undefined || typeof item.encrypted_content === 'string'), 'INPUT_CONTENT_NOT_ALLOWED')
    } else fail('INPUT_CONTENT_NOT_ALLOWED')
  }
  if (Array.isArray(input.input)) for (const item of input.input) scan(item)
  const body = JSON.parse(JSON.stringify({ ...input, model: policy.model, service_tier: 'default', store: false,
    truncation: 'disabled', max_output_tokens: input.max_output_tokens ?? policy.maxOutputTokens }))
  check(Buffer.byteLength(JSON.stringify(body)) <= 131072, 'REQUEST_TOO_LARGE')
  return body
}

export function officialOpenAISender({ credential, execute = false, fetchImpl = fetch } = {}) {
  check(execute === true, 'REAL_EXECUTION_NOT_APPROVED')
  check(fetchImpl !== fetch || new Date().toISOString().slice(0,10) === '2026-11-03', 'PRICE_VERIFICATION_STALE')
  check(typeof credential === 'string' && credential.length >= 16 && !/[\s\r\n]/.test(credential), 'CREDENTIAL_UNAVAILABLE')
  const request = (path, body, signal) => fetchImpl(`${OPENAI_ORIGIN}/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { count: (body, signal) => request('responses/input_tokens', body, signal),
    generate: (body, signal) => request('responses', body, signal),
    model: signal => request(`models/${OPENAI_MODEL}`, undefined, signal) }
}

export class OpenAITestGate {
  constructor(budget, sender) { this.budget = budget; this.sender = sender }
  async modelAccess(signal = AbortSignal.timeout(30000)) {
    const slot = this.budget.reserve({ model: OPENAI_MODEL }, { metadata: true })
    this.budget.mark(slot.count, 'started')
    try {
      const response = await this.sender.model(signal)
      check(response.ok, 'MODEL_ACCESS_UNVERIFIED')
      const result = await response.json()
      check(result.id === OPENAI_MODEL, 'MODEL_ACCESS_UNVERIFIED')
      this.budget.mark(slot.count, 'headers')
      return { id: result.id, verified: 'metadata only; inference can still be denied' }
    } catch { this.budget.mark(slot.count, 'unknown'); fail('MODEL_ACCESS_UNVERIFIED') }
  }
  async generate(input, signal = AbortSignal.timeout(60000)) {
    const body = prepareOpenAIRequest(input, this.budget.policy), slots = this.budget.reserve(body)
    const countFields = ['model','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','truncation']
    const countBody = Object.fromEntries(countFields.filter(key => body[key] !== undefined).map(key => [key, body[key]]))
    this.budget.mark(slots.count, 'started')
    try {
      const response = await this.sender.count(countBody, signal)
      check(response.ok, 'TOKEN_COUNT_UNAVAILABLE')
      const counted = await response.json()
      check(counted.object === 'response.input_tokens' && integer(counted.input_tokens, 0, this.budget.policy.maxInputTokens), 'INPUT_BUDGET_EXCEEDED')
      this.budget.mark(slots.count, 'headers')
    } catch (error) {
      this.budget.mark(slots.count, 'unknown'); this.budget.mark(slots.generation, 'not_sent')
      fail(['INPUT_BUDGET_EXCEEDED','TOKEN_COUNT_UNAVAILABLE'].includes(error.code) ? error.code : 'TOKEN_COUNT_UNAVAILABLE')
    }
    if (signal.aborted) {
      this.budget.mark(slots.generation, 'not_sent')
      signal.throwIfAborted()
    }
    this.budget.mark(slots.generation, 'started')
    try {
      const response = await this.sender.generate(body, signal)
      check(response.ok, 'UPSTREAM_REQUEST_FAILED')
      this.budget.mark(slots.generation, 'headers')
      return response
    } catch {
      this.budget.mark(slots.generation, 'unknown')
      fail('UPSTREAM_REQUEST_FAILED')
    }
  }
}

export async function startOpenAITestGuard({ gate, localToken, port = 0, onError, onRequest } = {}) {
  check(gate && typeof localToken === 'string' && localToken.length >= 32 && integer(port, 0, 65535), 'INVALID_GUARD_CONFIG')
  const expected = Buffer.from(digest(`Bearer ${localToken}`))
  const server = createServer(async (request, response) => {
    try {
      check(request.method === 'POST' && request.url === '/v1/responses', 'GUARD_ROUTE_NOT_ALLOWED')
      const candidate = request.headers.authorization
      check(typeof candidate === 'string' && timingSafeEqual(Buffer.from(digest(candidate)), expected), 'UNAUTHENTICATED')
      let bytes = 0
      const chunks = []
      for await (const chunk of request) { bytes += chunk.length; check(bytes <= 131072, 'REQUEST_TOO_LARGE'); chunks.push(chunk) }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('INVALID_REQUEST') }
      onRequest?.(input)
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 60000)
      const disconnected = () => { if (!response.writableEnded) abort.abort() }
      response.once('close', disconnected)
      try {
        const upstream = await gate.generate(input, abort.signal)
        response.writeHead(200, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' })
        let received = 0
        for await (const chunk of upstream.body) {
          received += chunk.length; check(received <= 1048576, 'RESPONSE_TOO_LARGE')
          if (!response.write(chunk)) await once(response, 'drain', { signal: abort.signal })
        }
        response.end()
      } finally { clearTimeout(timer); response.off('close', disconnected) }
    } catch (error) {
      onError?.(error.code ?? 'GUARD_REQUEST_FAILED')
      if (response.headersSent) { response.destroy(); return }
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'guard_error', code: error.code ?? 'GUARD_REQUEST_FAILED', message: error.code ?? 'Guard request failed' } }))
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: async () => {
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } }
}
