import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { startHub } from './server.js'

const configPath=process.argv[2]
if(!configPath){console.error('Usage: node src/cli.js <config.json>');process.exitCode=1}
else{
  try{
    const path=resolve(configPath), config=JSON.parse(readFileSync(path,'utf8'))
    const peers=config.peers?.map(peer=>({instanceId:peer.instanceId,instanceLabel:peer.instanceLabel,pairingRevision:peer.pairingRevision??1,credential:process.env[peer.credentialEnv]}))
    const tls=config.tls?{cert:process.env[config.tls.certificateEnv],key:process.env[config.tls.privateKeyEnv]}:undefined
    const hub=await startHub({...config,databasePath:resolve(dirname(path),config.databasePath),peers,tls})
    console.log(`DS-Bot communication Hub listening on ${hub.host}:${hub.port}; health /health`)
    let stopping=false
    const stop=async()=>{if(stopping)return;stopping=true;await hub.close()}
    process.once('SIGINT',()=>{void stop()});process.once('SIGTERM',()=>{void stop()})
  }catch(error){console.error(`Hub startup failed: ${error.code??'INVALID_CONFIG'}`);process.exitCode=1}
}
