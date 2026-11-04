import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { legacyCredential } from '../src/host/federation/legacy-credential.js'
import { CommunicationRuntime } from '../src/host/federation/runtime.js'
import { CommunicationTransport } from '../src/host/federation/transport.js'

const fixture = () => ({ rt: { home: join(tmpdir(), `synthetic-team-${randomUUID()}`), dshHome: tmpdir() },
  settings: { enabled: true, url: 'wss://hub.example.test/communication', instanceId: randomUUID(), credentialEnv: 'DSBOT_COMMUNICATION_TEST_RELOAD' } })
const synthetic = () => randomBytes(32).toString('hex')

test('runtime authentication rejection invalidates the process lease while transient network loss retains it', async () => {
  const f = fixture(), value = synthetic(), lease = legacyCredential(f.rt, f.settings, { [f.settings.credentialEnv]: value })
  const start = CommunicationTransport.prototype.start
  CommunicationTransport.prototype.start = () => {}
  let runtime
  try {
    runtime = new CommunicationRuntime({ ...f.rt, ctx: { on: () => () => {}, systemPrompt: { section: () => () => {} } } },
      { url: 'ws://127.0.0.1:3190/communication', instanceId: f.settings.instanceId, dataPath: ':memory:', publishedBotIds: [] }, lease.read, [], { onAuthenticationFailure: lease.invalidate })
    runtime.transport.onError({ code: 'CONNECTION_LOST' })
    assert.ok(lease.read() === value)
    runtime.transport.onError({ code: 'UNAUTHENTICATED' })
    assert.equal(legacyCredential(f.rt, f.settings, {}), undefined)
    assert.throws(() => lease.read(), { code: 'CREDENTIAL_UNAVAILABLE' })
  } finally { CommunicationTransport.prototype.start = start; await runtime?.close() }
})

test('consumed legacy bootstrap stays out of child environments and survives repeated same-binding plugin reactivation', () => {
  const { rt, settings } = fixture(), value = synthetic(), env = { [settings.credentialEnv]: value }
  const first = legacyCredential(rt, settings, env)
  assert.equal(Object.hasOwn(env, settings.credentialEnv), false)
  assert.ok(first.read() === value, 'bootstrap lease works without logging its value')
  for (let i = 0; i < 3; i++) assert.ok(legacyCredential(rt, { ...settings }, env).read() === value, 'reactivation uses only the same private binding')
  assert.equal(JSON.stringify(first), '{}', 'secret is not serializable in host state')
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {legacyCredential} from ${JSON.stringify(new URL('../src/host/federation/legacy-credential.js', import.meta.url).href)}; console.log(Boolean(legacyCredential(${JSON.stringify(rt)},${JSON.stringify(settings)},{})))`], { encoding: 'utf8', env: { ...process.env }, windowsHide: true })
  assert.equal(child.status, 0); assert.equal(child.stdout.trim(), 'false', 'a fresh process never recovers a consumed process-only bootstrap')
  first.invalidate(); assert.throws(() => first.read(), { code: 'CREDENTIAL_UNAVAILABLE' })
})

test('legacy cache is isolated by profile/team, Hub, instance, queue and environment reference; changed configuration clears the old lease', () => {
  for (const change of [{ url: 'wss://other.example.test/communication' }, { instanceId: 'other' }, { dataPath: 'other.sqlite' }, { credentialEnv: 'DSBOT_COMMUNICATION_OTHER' }]) {
    const { rt, settings } = fixture(), first = legacyCredential(rt, settings, { [settings.credentialEnv]: synthetic() })
    assert.equal(legacyCredential({ ...rt, home: rt.home + '-other' }, settings, {}), undefined)
    assert.equal(legacyCredential({ ...rt, dshHome: rt.dshHome + '-other' }, settings, {}), undefined)
    assert.equal(legacyCredential(rt, { ...settings, ...change }, {}), undefined)
    assert.throws(() => first.read(), { code: 'CREDENTIAL_UNAVAILABLE' })
    assert.equal(legacyCredential(rt, settings, {}), undefined, 'switching back cannot resurrect an evicted credential')
  }
})

test('disable, signing-record switch, explicit invalidation and invalid replacement remove cached bootstrap; valid rotation replaces it', () => {
  for (const change of [{ enabled: false }, { credentialKey: 'ds-bot/approved-signing-record' }]) {
    const { rt, settings } = fixture(), first = legacyCredential(rt, settings, { [settings.credentialEnv]: synthetic() })
    assert.equal(legacyCredential(rt, { ...settings, ...change }, {}), undefined)
    assert.throws(() => first.read(), { code: 'CREDENTIAL_UNAVAILABLE' })
  }
  const signing = fixture(), unusedBootstrap = { [signing.settings.credentialEnv]: synthetic() }
  assert.equal(legacyCredential(signing.rt, { ...signing.settings, credentialKey: 'ds-bot/approved-signing-record' }, unusedBootstrap), undefined)
  assert.equal(Object.hasOwn(unusedBootstrap, signing.settings.credentialEnv), false, 'unused bootstrap never leaks into signing-record tools')
  const { rt, settings } = fixture(), first = legacyCredential(rt, settings, { [settings.credentialEnv]: synthetic() }), nextValue = synthetic()
  const next = legacyCredential(rt, settings, { [settings.credentialEnv]: nextValue })
  assert.throws(() => first.read(), { code: 'CREDENTIAL_UNAVAILABLE' }); assert.ok(next.read() === nextValue)
  first.invalidate(); assert.ok(next.read() === nextValue, 'an old runtime cannot invalidate a newer rotation')
  const invalid = { [settings.credentialEnv]: 'invalid-test-value' }
  assert.equal(legacyCredential(rt, settings, invalid), undefined)
  assert.equal(Object.hasOwn(invalid, settings.credentialEnv), false)
  assert.throws(() => next.read(), { code: 'CREDENTIAL_UNAVAILABLE' })
})
