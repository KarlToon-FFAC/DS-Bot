// Minimal reproduction of a pending ordinary followup surviving process loss.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { benchClient, modelCalls, repo } from './bench-client.mjs'

const name = 'communication-b'
const invoke = action => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-File', join(import.meta.dirname, 'bench.ps1'), action,
    '-Name', name, '-WebPort', '3102', '-MockPort', '8802'], { cwd: join(repo, 'ds-bot'), stdio: 'ignore', windowsHide: true })
  if (result.status !== 0) throw new Error(`Bench ${action} failed (${result.status})`)
}
const runId = `p0-queued-${randomUUID()}`
const report = { runId, status: 'NOT_RUN', scope: 'native Windows / two ordinary followups / loopback Mock', dsh: '0.2.1-rc.4' }
let started = false
try {
  invoke('start'); started = true
  let { api } = await benchClient(name, 3102)
  const conversationId = runId
  await api({ operation: 'bind', conversationId })
  await api({ operation: 'arm', conversationId, point: 'after-output' })
  await api({ operation: 'send', conversationId, messageId: `${runId}-first-message`, deliveryId: `${runId}-first-delivery`, text: 'first reply' })
  const deadline = Date.now() + 20000
  while ((await api({ operation: 'checkpoint', conversationId })).point !== 'after-output') {
    if (Date.now() > deadline) throw new Error('First turn checkpoint was not reached')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const input = { conversationId, messageId: `${runId}-pending-message`, deliveryId: `${runId}-pending-delivery`, text: 'second ordinary followup' }
  assert.equal((await api({ operation: 'send', ...input })).status, 'queued')
  const beforeCalls = modelCalls(name)
  invoke('stop'); started = false
  invoke('start'); started = true
  ;({ api } = await benchClient(name, 3102))
  report.recovered = await api({ operation: 'recover', ...input })
  assert.equal(report.recovered.input.status, 'queued')
  await api({ operation: 'wait', conversationId })
  report.publicWake = await api({ operation: 'queue-wake-probe', ...input })
  await new Promise(resolve => setTimeout(resolve, 1000))
  report.after = await api({ operation: 'inspect', ...input })
  report.additionalModelCalls = modelCalls(name) - beforeCalls
  assert.equal(report.additionalModelCalls, 0)
  assert.equal(report.publicWake.followup, 'duplicate_pending_rejected')
  assert.equal(report.publicWake.steer, 'session/steer-unavailable')
  assert.equal(report.after.input.status, 'queued')
  report.resume = await api({ operation: 'resume-pending', ...input })
  assert.equal(report.resume.resumed, true)
  assert.equal(report.resume.notice.kind, 'ds-bot-communication-recovery')
  assert.equal(report.resume.notice.form, 'notice')
  await api({ operation: 'wait', conversationId })
  report.final = await api({ operation: 'inspect', ...input })
  assert.equal(report.final.input.status, 'admitted')
  assert.equal(report.final.input.messageId, report.recovered.input.messageId, 'the original DSH input identity must be consumed unchanged')
  assert.equal(report.final.outputs.length, 1, 'the recovered input must produce one visible final reply')
  assert.ok(report.final.outputs[0].parts.some(part => part.text.trim()))
  assert.equal(modelCalls(name) - beforeCalls, 1, 'the recovery notice must share one call with the original pending input')
  assert.equal((await api({ operation: 'resume-pending', ...input })).resumed, false)
  await api({ operation: 'wait', conversationId })
  assert.equal(modelCalls(name) - beforeCalls, 1)
  invoke('stop'); started = false
  invoke('start'); started = true
  ;({ api } = await benchClient(name, 3102))
  report.secondRestart = await api({ operation: 'resume-pending', ...input })
  assert.equal(report.secondRestart.resumed, false)
  assert.equal(report.secondRestart.input.status, 'admitted')
  assert.equal(modelCalls(name) - beforeCalls, 1)
  report.additionalModelCalls = modelCalls(name) - beforeCalls
  report.status = 'PASS'
  report.reason = 'A truthful host-restart notice with its own producer source is admitted through public steer beside the original pending input. The original DSH input ID is consumed once; retries and another restart do not add calls. No input is removed or resubmitted, and no DSH patch/private method is used.'
  console.log('PASS P0 pending recovery: source-labelled restart notice wakes the original pending input through public steer; same input ID, one model call, idempotent retry and second restart.')
} finally {
  if (started) invoke('stop')
  writeFileSync(join(repo, '.dsh-test-tools/p0-queued-recovery.json'), JSON.stringify(report, null, 2) + '\n')
}
process.exitCode = report.status === 'PASS' ? 0 : 1
