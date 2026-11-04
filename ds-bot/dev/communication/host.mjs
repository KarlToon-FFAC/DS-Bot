// Same documented profile boot entry point used by app/src/host.mjs.
import { createRequire } from 'node:module'
import { mkdirSync, symlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
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
if (process.env.DSBOT_COMMUNICATION_ONBOARDING_FIXTURE === '1') {
  if (!/^\.dsh-test-hub-onboard-[a-f0-9]{8}(?:-[a-z0-9-]+)?-[ab]$/.test(basename(root))) throw new Error('Use a fresh owned onboarding profile')
  const marker = join(root, '.onboarding-normal-profile'), patch = join(dir, 'cordis.patch.yml')
  if (!existsSync(marker)) {
    const initial = existsSync(patch) ? readFileSync(patch, 'utf8').split(/\r?\n/).filter(line => !line.trim().startsWith('#')).join('\n').trim() : ''
    if (existsSync(join(root, 'bot/communication.sqlite')) || initial && initial !== '[]') throw new Error('Onboarding fixture refuses to replace an existing profile configuration')
    writeFileSync(patch, '- id: bot\n  config:\n    checkRatio: 0.45\n')
    writeFileSync(marker, 'Fresh onboarding profile initialized once.\n')
  }
}
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
