import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { communicationError } from '../../src/shared/communication-diagnostics.js'

export const repo = resolve(import.meta.dirname, '../../..')
export function benchResponseValue(data) {
  if (data?.ok === true) return data.value
  const { code } = communicationError(data?.error)
  throw Object.assign(new Error(code), { code })
}
export function modelCalls(name) {
  try { return readFileSync(join(repo, `.dsh-test-${name}`, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).length } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}
export async function benchClient(name, port) {
  const log = readFileSync(join(repo, `.dsh-test-${name}`, 'web.log'), 'utf8')
  const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  assert.ok(url, 'isolated bench must have a login URL')
  const response = await fetch(url, { redirect: 'manual', headers: { connection: 'close' }, signal: AbortSignal.timeout(15000) })
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'isolated login must return a cookie')
  const request = async (path, body) => {
    const result = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie, connection: 'close' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    })
    const data = await result.json()
    return benchResponseValue(data)
  }
  const team = await request('/api/bot', { endpoint: 'state' })
  const api = body => request('/api/communication-probe', body)
  const identity = await api({ operation: 'identity' })
  assert.equal(identity.botId, team.mainBotId)
  return { api, identity, request }
}
