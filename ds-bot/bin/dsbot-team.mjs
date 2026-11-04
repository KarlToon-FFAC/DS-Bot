#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execute } from './dsbot-remote.mjs'
import { MEMORY_LIMITS } from '../src/shared/memory-limits.js'

const fail = (code, exitCode = 2) => { throw Object.assign(new Error(code), { code, exitCode }) }
const object = value => value && typeof value === 'object' && !Array.isArray(value)
export function prepareTeam(operation, input = {}) {
  const schemas = { state: [], 'set-workspace': ['id', 'workDir'], 'memory-view': ['botId', 'roomId'], 'memory-capacity': [] }
  if (!Object.hasOwn(schemas, operation) || !object(input)) fail('INVALID_OPERATION_OR_INPUT')
  for (const [key, value] of Object.entries(input)) {
    if (!schemas[operation].includes(key) || typeof value !== 'string' || key !== 'workDir' && !value.trim()) fail('INVALID_FIELD')
  }
  if (operation === 'set-workspace' && (!input.id || input.workDir === undefined)) fail('MISSING_REQUIRED_FIELD')
  if (operation === 'memory-view' && Boolean(input.botId) === Boolean(input.roomId)) fail('ONE_MEMORY_TARGET_REQUIRED')
  return { operation: 'team-' + operation, request: { endpoint: operation === 'set-workspace' ? 'update-bot' : operation,
    payload: operation === 'memory-view' ? { ...input, summarize: false, regenerate: false } : input } }
}

export const teamHelp = () => ({ name: 'dsbot-team', identity: 'Authenticated local Human only. No Bot actor/sender override.',
  usage: 'dsbot-team <state|set-workspace|memory-view|memory-capacity> [--json] [--config <explicit-file>] < input.json',
  authentication: 'DSBOT_TEAM_URL and DSBOT_TEAM_COOKIE, or explicit config JSON {url,cookie}. Loopback only, fixed /api/bot, no redirects or credential discovery.',
  operations: { state: {}, 'set-workspace': { id: 'Exact local Bot ID from state', workDir: 'Existing absolute folder; empty string restores team workspace' },
    'memory-view': { botId: 'Exact Bot ID, or use roomId for a local group', roomId: 'Exact local group ID; choose exactly one target' }, 'memory-capacity': 'Offline fixed limits; no authentication required' },
  permission: 'The user may edit Bot settings through the authenticated local API. A Main Bot uses update_bot with bot/work_dir; other Bots may edit only themselves. Neither CLI acts as a Bot.',
  exits: { 0: 'success', 2: 'usage/input', 3: 'config/authentication', 4: 'API rejection', 5: 'uncertain; inspect state before repeating the same workspace assignment' },
  skill: fileURLToPath(new URL('../skills/dsbot-team/SKILL.md', import.meta.url)) })

export async function main(argv = process.argv.slice(2), env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr) {
  let cookie
  const write = (stream, value) => {
    let raw = JSON.stringify(value)
    if (cookie) raw = raw.split(JSON.stringify(cookie).slice(1, -1)).join('[REDACTED]')
    stream.write(raw + '\n')
  }
  try {
    const [operation, ...args] = argv
    if (!operation || ['help', '--help'].includes(operation) || args.includes('--help')) { write(stdout, teamHelp()); return 0 }
    let config = {}
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') continue
      if (args[i] !== '--config' || !args[i + 1]) fail('INVALID_ARGUMENT')
      try { config = JSON.parse(await readFile(args[++i], 'utf8')) } catch { fail('INVALID_EXPLICIT_CONFIG', 3) }
      if (!object(config) || Object.keys(config).some(key => !['url', 'cookie'].includes(key))) fail('INVALID_EXPLICIT_CONFIG', 3)
    }
    if (operation === 'memory-capacity') { write(stdout, { ok: true, value: { limits: MEMORY_LIMITS, measure: 'UTF-16 code units (JavaScript string.length); main is per MEMORY.md, not a directory total' } }); return 0 }
    cookie = env.DSBOT_TEAM_COOKIE ?? config.cookie
    let raw = ''
    if (!stdin.isTTY) for await (const chunk of stdin) { raw += chunk; if (raw.length > 1024 * 1024) fail('INPUT_TOO_LARGE') }
    let input
    try { input = raw.trim() ? JSON.parse(raw) : {} } catch { fail('INVALID_JSON') }
    write(stdout, await execute(prepareTeam(operation, input), { url: env.DSBOT_TEAM_URL ?? config.url, cookie, apiPath: '/api/bot' }))
    return 0
  } catch (error) {
    write(stderr, { ok: false, error: { code: error.code ?? 'CLI_FAILURE' }, ...(error.request ? { request: error.request } : {}) })
    return error.exitCode ?? 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main()
