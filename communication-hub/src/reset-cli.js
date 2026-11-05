#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resetHub, RESET_CONFIRMATION } from './reset.js'

export function main(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  if (argv.length === 1 && argv[0] === '--help') {
    stdout.write(`Usage: npm run reset -- --config <config.json> --confirm "${RESET_CONFIRMATION}"\nStop the Hub normally first. Irreversibly deletes all Hub identities, users, groups, messages, credentials, pairing and recovery state; clears static peers in the selected config. No backup. TLS and network settings remain. Restart creates a new Hub ID. A failed/interrupted reset must be rerun before startup. Never delete the empty .lock coordination file.\n`)
    return 0
  }
  try {
    if (argv.length !== 4 || argv[0] !== '--config' || argv[2] !== '--confirm') throw Object.assign(new Error(), { code: 'INVALID_ARGUMENT' })
    stdout.write(JSON.stringify({ ok: true, value: resetHub({ configPath: argv[1], confirmation: argv[3] }) }) + '\n')
    return 0
  } catch (error) {
    stderr.write(JSON.stringify({ ok: false, incomplete: true, error: { code: error.code ?? 'RESET_FAILED' }, action: 'Stop the Hub normally, correct the error and rerun the same explicit reset command.' }) + '\n')
    return 2
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()
