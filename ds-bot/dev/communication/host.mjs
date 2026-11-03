// Same documented profile boot entry point used by app/src/host.mjs.
import { createRequire } from 'node:module'
import { mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { watchOwnedParent } from './owned-parent.mjs'
watchOwnedParent()

const plugin = resolve(import.meta.dirname, '../..')
const anchor = join(plugin, 'dev/harness/package.json')
const require = createRequire(anchor)
const { initProfile, loadProfileDirectory, loadLayeredEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')))
const { runProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')))
const root = process.env.DSH_HOME
if (!root || !process.env.DSBOT_COMMUNICATION_PROBE) throw new Error('Use the isolated communication bench')
const dir = join(root, 'profiles', 'communication-test')
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot', 'ds-bot-communication-probe']
initProfile(dir, bundles)
const modules = join(dir, 'node_modules')
mkdirSync(modules, { recursive: true })
for (const [name, source] of [['ds-bot', plugin], ['ds-bot-communication-probe', join(plugin, 'dev/communication/probe-plugin')]]) {
  const link = join(modules, name)
  if (!existsSync(link)) symlinkSync(source, link, 'junction')
}
const profile = loadProfileDirectory('dsh', dir, anchor)
if (profile.skippedBundles.length) throw new Error('The isolated profile cannot resolve all required bundles')
await runProfile({
  environment: loadLayeredEnv('dsh'), profile: 'communication-test',
  resolvedProfile: { profile, installAnchor: anchor },
  patchFiles: [join(root, 'bench.patch.yml')],
  args: [...(process.env.DSBOT_WEB_OPEN === '1' ? [] : ['--no-open']), '--host', '127.0.0.1', '--port', process.env.DSBOT_WEB_PORT],
})
