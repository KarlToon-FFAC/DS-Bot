import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
// The password is supplied explicitly through the process environment, never argv.
export async function adminCommand(args, { password = process.env.DSBOT_HUB_ADMIN_PASSWORD, fetcher = fetch } = {}) {
  if (args[0] === '--help' || args[0] === '-h') return { usage: 'admin-cli.mjs <https-origin> state|decide|revoke|repair|rename|delete [input.json]', credential: 'DSBOT_HUB_ADMIN_PASSWORD (explicit environment only)' }
  const [url, command, inputFile] = args
  const target = new URL(url)
  if (!(target.protocol === 'https:' || target.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(target.hostname)) || target.username || target.password || target.search || target.hash || !['state', 'decide', 'revoke', 'repair', 'rename', 'delete'].includes(command)) throw Error('INVALID_ARGUMENTS')
  if (typeof password !== 'string' || password.length < 16) throw Error('ADMIN_PASSWORD_UNAVAILABLE')
  const input = inputFile ? JSON.parse(readFileSync(inputFile, 'utf8')) : {}
  const response = await fetcher(new URL('/admin/api/' + command, target.origin), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + password }, body: JSON.stringify(input) })
  const result = await response.json()
  if (!response.ok || !result.ok) throw Error(result.error?.code ?? 'ADMIN_REQUEST_FAILED')
  return result.value
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await adminCommand(process.argv.slice(2)), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
