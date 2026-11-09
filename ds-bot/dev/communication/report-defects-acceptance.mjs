import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalTopology, until } from './local-topology.mjs'
import { repo } from './bench-client.mjs'

const nonce = randomUUID().slice(0, 8)
const topology = new LocalTopology({ prefix: `report-defects-${nonce}`, webPort: 3305, mockPort: 9005, hubPort: 3309 })
const evidence = { status: 'RUNNING', model: 'deterministic Mock', cases: [] }
const record = name => { evidence.cases.push(name); console.log('PASS', name) }
async function login(peer) {
  const log = readFileSync(join(peer.home, 'web.log'), 'utf8')
  const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${peer.web}/\\?token=[^\\s]+`))?.[0]
  assert.ok(url, 'Owned test profile has a login URL')
  const result = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  peer.cookie = result.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
}
async function cli(peer, command, input = {}) {
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'].includes(key)))
    const child = spawn(process.execPath, [join(repo, 'ds-bot/bin/dsbot-remote.mjs'), command], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...environment, DSBOT_REMOTE_URL: `http://127.0.0.1:${peer.web}`, DSBOT_REMOTE_COOKIE: peer.cookie },
    })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(Error('CLI_TIMEOUT')) }, 60000)
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      try { resolve({ code, body: JSON.parse((code === 0 ? stdout : stderr).trim().split('\n').findLast(line => line.startsWith('{'))) }) }
      catch { reject(Error('CLI_INVALID_JSON')) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

try {
  await topology.initialize()
  const [a,b]=topology.peers
  await Promise.all(topology.peers.map(login))
  const request=await a.api({endpoint:'request-contact',userCode:(await b.api({endpoint:'user-code'})).userCode,operationId:randomUUID()})
  const incoming=await until(async()=>(await b.api({endpoint:'contact-requests'})).find(row=>row.requestId===request.requestId),'incoming contact')
  await b.api({endpoint:'accept-contact',requestId:incoming.requestId,expectedVersion:incoming.version,operationId:randomUUID()})
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG0cAAAAASUVORK5CYII='
  const saved=await cli(b,'profile-human',{avatar:{image},operationId:randomUUID()})
  assert.equal(saved.code,0,saved.body.error?.code)
  const revision=saved.body.value.avatar.imageRevision
  const result=await cli(a,'avatar',{principalId:b.human,revision})
  assert.equal(result.code,0,result.body.error?.code)
  assert.equal(result.body.value.image,image)
  record('real-CLI-downloads-an-authorized-remote-custom-avatar')
  await b.client.request('/api/bot',{endpoint:'update-bot',payload:{id:b.botId,avatar:{image}}})
  const botAvatar=await until(async()=>(await a.api({endpoint:'state'})).contacts.find(person=>person.principalId===b.bot&&person.avatar?.imageRevision)?.avatar,'remote Bot avatar publication')
  const botImage=await cli(a,'avatar',{principalId:b.bot,revision:botAvatar.imageRevision})
  assert.equal(botImage.code,0,botImage.body.error?.code);assert.equal(botImage.body.value.image,image)
  record('real-CLI-downloads-a-published-remote-Bot-custom-avatar')
  const stale=await cli(a,'avatar',{principalId:b.human,revision:'a'.repeat(64)})
  assert.notEqual(stale.code,0);assert.equal(stale.body.error.code,'AVATAR_REVISION_MISMATCH')
  record('stale-avatar-revision-retains-specific-diagnostic-instead-of-COMMUNICATION_UNAVAILABLE')
  await cli(b,'profile-human',{avatar:null,operationId:randomUUID()})
  const generated=await cli(a,'avatar',{principalId:b.human,revision})
  assert.notEqual(generated.code,0);assert.equal(generated.body.error.code,'AVATAR_REVISION_MISMATCH')
  record('generated-avatar-without-custom-image-is-explicitly-unavailable')
  const snapshot=await a.api({endpoint:'state'})
  assert.equal(snapshot.compatibility.status,'matched')
  assert.ok(snapshot.compatibility.clientVersion);assert.equal(snapshot.compatibility.clientVersion,snapshot.compatibility.hubVersion)
  record('real-Hub-and-client-report-matching-federation-release-in-live-state')
  const group=await topology.group(`Field report ${nonce}`)
  const tag=`report-${nonce}`
  await topology.send(a,group,`COMM-ECHO ${tag}`,[b.bot])
  await until(()=>topology.hasText(a,group,`Communication reply ${tag}`),'actual Mock reply',60000)
  record('avatar-and-version-diagnostics-preserve-real-two-DSH-Mock-collaboration')
  evidence.status='PASSED'
} catch(error){evidence.status='FAILED';evidence.error=error.code ?? error.message;throw error}
finally{await topology.close();writeFileSync(join(topology.root,`${topology.prefix}-evidence.json`),JSON.stringify(evidence,null,2))}
