// Input-channel rehearsal only: no network modules, model sender, files or DSH.
import { pathToFileURL } from 'node:url'
const REFERENCE = 'DSBOT_COMMUNICATION_OPENAI_INPUT'

export function consumePrivateInput(environment) {
  const value = environment[REFERENCE]
  delete environment[REFERENCE]
  if (typeof value !== 'string' || value.length < 16 || /\s/.test(value)) {
    throw Object.assign(new Error('INPUT_INVALID'), { code: 'INPUT_INVALID' })
  }
  return value
}

export function rehearsePrivateInput(environment) {
  consumePrivateInput(environment)
  return { status: 'PASS_INPUT_CHANNEL_ONLY', networkCalls: 0,
    environmentRemoved: !Object.hasOwn(environment, REFERENCE), credentialDiscarded: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(rehearsePrivateInput(process.env)) + '\n') }
  catch { process.stderr.write('INPUT_INVALID\n'); process.exitCode = 1 }
}
