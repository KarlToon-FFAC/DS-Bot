import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { benchClient, repo } from './bench-client.mjs'
import { until } from './local-topology.mjs'

const name = `hub-onboard-${randomUUID().slice(0,8)}-fresh-enable-a`
const web = 3495, mock = 9195, home = join(repo, `.dsh-test-${name}`)
const evidence = { status: 'RUNNING', model: 'deterministic Mock', hubStarted: false, cases: [] }
const record = value => { evidence.cases.push(value); console.log('PASS', value) }
const bench = (action, normal = true) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(repo, 'ds-bot/dev/communication/bench.mjs'), action, name, String(web), String(mock)], {
    stdio: ['ignore','ignore','pipe'], env: { ...process.env, DSBOT_COMMUNICATION_CONFIG: '', DSBOT_COMMUNICATION_ONBOARDING_FIXTURE: normal ? '1' : '', DSBOT_COMMUNICATION_OWNER_PID: String(process.pid) },
  })
  let diagnostic = ''
  child.stderr.on('data', part => { diagnostic += part })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(Error(/^[A-Z_]+\s*$/.test(diagnostic) ? diagnostic.trim() : 'OWNED_BENCH_FAILED')))
})
const connect = async () => {
  const client = await benchClient(name, web)
  return body => client.request('/api/communication', body)
}
const enable = async api => {
  const preview = await api({endpoint:'remote-hub-settings'})
  return api({endpoint:'set-remote-hub-enabled', enabled:true, expectedVersion:preview.version})
}
const ready = api => until(async () => {
  const state = await api({endpoint:'remote-hub-settings'})
  return state.enabled && !state.reloadRequired && state
}, 'fresh feature applied without a Hub')
try {
  await bench('start')
  let api = await connect()
  assert.equal((await api({endpoint:'remote-hub-settings'})).enabled, false)
  await enable(api)
  assert.equal((await ready(api)).configured, false)
  record('fresh profile enables locally without any Hub, enrollment, Bot publication or connection')
  await bench('stop')

  // Reset only this owned profile's test flag before testing startup precedence.
  writeFileSync(join(home, 'profiles/communication-test/cordis.patch.yml'), '- id: bot\n  config:\n    checkRatio: 0.45\n')
  await bench('start', false)
  api = await connect()
  await assert.rejects(enable(api), {code:'CONFIG_EDIT_OVERLAID'})
  assert.equal((await api({endpoint:'remote-hub-settings'})).enabled, false)
  record('a real command-line Bot config overlay is identified as a local save rejection and stays off')
  await bench('stop')

  await bench('start')
  api = await connect()
  await enable(api)
  await ready(api)
  await bench('stop')
  await bench('start')
  api = await connect()
  assert.equal((await ready(api)).configured, false)
  record('removing the conflicting startup overlay allows enabling, and the setting survives Host restart')
  evidence.status = 'PASS'
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = error.code ?? error.message
  throw error
} finally {
  await bench('stop').catch(() => {})
  writeFileSync(join(home, 'fresh-enable-acceptance.json'), JSON.stringify(evidence, null, 2))
}
