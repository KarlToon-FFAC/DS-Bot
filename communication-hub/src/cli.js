import { readFileSync, mkdirSync } from 'node:fs'
import { acquireDatabaseLock, safeFile, resetError } from './database-lock.js'
import { resolve, dirname } from 'node:path'
import { startHub } from './server.js'

const configPath=process.argv[2]
function pairingCa(config) {
  if (!config.management?.enabled) return undefined
  if (!config.management.pairingCaFile || !String(config.management.url ?? config.management.publicUrl ?? '').startsWith('wss:') || !config.tls || !process.env[config.tls.certificateEnv] || !process.env[config.tls.privateKeyEnv]) throw resetError('HUB_V2_MIGRATION_REQUIRED')
  try { return readFileSync(resolve(dirname(configPath),config.management.pairingCaFile),'utf8') }
  catch { throw resetError('HUB_V2_MIGRATION_REQUIRED') }
}

if(!configPath){console.error('Usage: node src/cli.js <config.json>');process.exitCode=1}
else{
  let databaseLock
  try{
    const path=safeFile(configPath), initial=JSON.parse(readFileSync(path,'utf8'))
    pairingCa(initial)
    const databasePath=safeFile(resolve(dirname(path),initial.databasePath))
    mkdirSync(dirname(databasePath),{recursive:true})
    databaseLock=acquireDatabaseLock(databasePath)
    // Read static credentials only after fencing resets, not from a stale pre-lock config.
    const config=JSON.parse(readFileSync(path,'utf8'))
    if(resolve(dirname(path),config.databasePath)!==databasePath)throw resetError('CONFIG_CHANGED')
    const peers=config.peers?.map(peer=>({instanceId:peer.instanceId,instanceLabel:peer.instanceLabel,pairingRevision:peer.pairingRevision??1,credential:process.env[peer.credentialEnv]}))
    const tls=config.tls?{cert:process.env[config.tls.certificateEnv],key:process.env[config.tls.privateKeyEnv]}:undefined
    const management=config.management?.enabled?{...config.management,password:config.management.adminPasswordEnv?process.env[config.management.adminPasswordEnv]:undefined,
      pairingCa:pairingCa(config)}:undefined
    const hub=await startHub({...config,databasePath,databaseLock,peers,tls,management})
    console.log(`DS-Bot communication Hub listening on ${hub.host}:${hub.port}; health /health`)
    if(hub.managementUrl)console.log(`Hub management: ${hub.managementUrl}`)
    let stopping=false
    const stop=async()=>{if(stopping)return;stopping=true;await hub.close()}
    process.once('SIGINT',()=>{void stop()});process.once('SIGTERM',()=>{void stop()})
  }catch(error){databaseLock?.close();console.error(`Hub startup failed: ${error.code??'INVALID_CONFIG'}${error.code==='HUB_V2_MIGRATION_REQUIRED'?' — configure management.url, management.pairingCaFile and matching TLS certificate/key':''}`);process.exitCode=1}
}
