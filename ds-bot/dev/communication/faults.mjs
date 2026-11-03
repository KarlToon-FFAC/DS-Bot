import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { benchClient, modelCalls, repo } from './bench-client.mjs'

const name = 'communication-b'
const port = 3102
const invoke = action => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', join(import.meta.dirname, 'bench.ps1'), action,
    '-Name', name, '-WebPort', String(port), '-MockPort', '8802'], { cwd: join(repo, 'ds-bot'), stdio: 'ignore', windowsHide: true })
  if (result.status !== 0) throw new Error(`Bench ${action} failed with exit ${result.status}`)
}
const waitCheckpoint = async (api, conversationId, point) => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const checkpoint = await api({ operation: 'checkpoint', conversationId })
    if (checkpoint.point === point) { assert.equal(checkpoint.flushed, true); return }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Checkpoint ${point} not reached`)
}
const report = { runId: `p0-fault-${randomUUID()}`, cases: [], network: 'loopback', dsh: '0.2.1-rc.4' }
let started = false
try {
  invoke('start')
  started = true
  for (const point of ['before-admission', 'after-output']) {
    let { api } = await benchClient(name, port)
    const conversationId = `${report.runId}-${point}`
    await api({ operation: 'bind', conversationId })
    await api({ operation: 'arm', conversationId, point })
    const input = { conversationId, messageId: `${conversationId}-message`, deliveryId: `${conversationId}-delivery`, text: `hello ${point}` }
    const beforeCalls = modelCalls(name)
    await api({ operation: 'send', ...input })
    await waitCheckpoint(api, conversationId, point)
    const before = await api({ operation: 'inspect', diagnostics: true, ...input })
    const liveRecovery = await api({ operation: 'recover', ...input })
    assert.equal(liveRecovery.input.reason, 'input_in_flight', 'live input must not receive a replay grant')
    invoke('stop')
    started = false
    invoke('start')
    started = true
    ;({ api } = await benchClient(name, port))
    const after = await api({ operation: 'inspect', diagnostics: true, ...input })
    assert.equal(modelCalls(name) - beforeCalls, point === 'before-admission' ? 0 : 1)
    const reconciled = await api({ operation: 'recover', ...input })
    if (point === 'before-admission') {
      assert.equal(before.input.status, 'injection_unknown')
      assert.equal(reconciled.input.status, 'not_admitted')
      assert.equal(reconciled.input.proof, 'exclusive_idle_writer')
      await api({ operation: 'send', recovery: true, ...input })
      await api({ operation: 'wait', conversationId })
      const retried = await api({ operation: 'inspect', ...input })
      assert.equal(retried.input.status, 'admitted')
      assert.equal(retried.outputs.length, 1)
      await api({ operation: 'send', recovery: true, ...input })
      await api({ operation: 'wait', conversationId })
      assert.equal(modelCalls(name) - beforeCalls, 1, 'one logical delivery must only be admitted once')
    } else {
      assert.equal(reconciled.input.status, 'admitted')
      assert.equal(reconciled.outputs.length, 1, 'persisted final output must survive a missing turn/end')
      assert.deepEqual(await api({ operation: 'recover', ...input }), reconciled)
      assert.equal(modelCalls(name) - beforeCalls, 1, 'recovery must not regenerate a persisted reply')
    }
    report.cases.push({ point, checkpointFlushed: true, liveRecovery, before, after, reconciled, modelCalls: modelCalls(name) - beforeCalls, status: 'PASS' })
    console.log(`PASS real process loss at ${point}: fenced reconciliation=${reconciled.input.status}, recovered outputs=${reconciled.outputs.length}`)
  }
} finally {
  if (started) invoke('stop')
  writeFileSync(join(repo, '.dsh-test-tools/p0-faults.json'), JSON.stringify(report, null, 2) + '\n')
}
