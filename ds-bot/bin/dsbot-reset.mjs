#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resetFederation, RESET_CONFIRMATION } from '../src/host/federation/reset.js'
const runtime = process.env.DSH_HARNESS ?? join(import.meta.dirname, '..', 'dev', 'harness')
if (existsSync(join(runtime, 'package.json'))) {
  const base = join(runtime, 'packages', 'bundle', 'base', 'package.json')
  const anchor = pathToFileURL(existsSync(base) ? base : resolve(runtime, 'package.json')).href
  registerHooks({ resolve(specifier, context, next) { return next(specifier, specifier.startsWith('@deepseek-ai/') ? { ...context, parentURL: anchor } : context) } })
}
const usage = `Usage: dsbot-reset --home <absolute plugin home> --profile <absolute patch.yml> [--profile <additional actual overlay>] --credentials <absolute local YAML store> --sessions <absolute JSONL session root> --attachments-home <actual attachment provider DSH home> --storage-root <actual JSON storage root> [--confirm ${RESET_CONFIRMATION}]\nStop every Host using this profile first. Default: dry run. Confirmation permanently erases ALL federation data on this client without a backup. Local Bots, ordinary chats and model settings are preserved. Reset the Hub separately. Refresh every connected browser afterward.`
try {
  const options = { profiles: [] }, args = process.argv.slice(2)
  if (args.includes('--help')) { console.log(usage) } else {
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i], value = args[i + 1]
      if (!['--home', '--profile', '--credentials', '--sessions', '--attachments-home', '--storage-root', '--confirm'].includes(name) || !value || value.startsWith('--')) throw new Error('RESET_INVALID_ARGUMENTS')
      if (name === '--profile') options.profiles.push(value)
      else { const key = name === '--attachments-home' ? 'attachmentsHome' : name === '--storage-root' ? 'storageRoot' : name.slice(2); if (Object.hasOwn(options, key)) throw new Error('RESET_INVALID_ARGUMENTS'); options[key] = value }
    }
    if (!options.home || !options.credentials || !options.sessions || !options.attachmentsHome || !options.storageRoot || !options.profiles.length || options.confirm !== undefined && options.confirm !== RESET_CONFIRMATION) throw new Error('RESET_INVALID_ARGUMENTS')
    console.log(JSON.stringify(await resetFederation(options)))
  }
} catch (error) { console.error(JSON.stringify({ ok: false, incomplete: true, error: { code: error.code ?? (/^[A-Z_]+$/.test(error.message) ? error.message : 'RESET_FAILED'), ...(typeof error.target === 'string' ? { target: error.target } : {}) } })); process.exitCode = 1 }
