#!/usr/bin/env node
import {request as httpRequest} from 'node:http'
import {request as httpsRequest} from 'node:https'
import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'

const fields={'delete-join':['requestId','expectedVersion','confirmDelete'],state:[], 'hub-code':[],approve:['requestId','expectedVersion'],reject:['requestId','expectedVersion'],rename:['instanceId','label','expectedNameVersion'],revoke:['instanceId'],repair:['instanceId','expectedRevision'],delete:['instanceId','expectedPairingRevision','expectedNameVersion','ownedSharedGroups','confirmDelete'],'revoke-sessions':[]}
const routes={approve:'decide',reject:'decide','hub-code':'state','revoke-sessions':'sessions/revoke'}
const fail=(code,uncertain=false)=>{throw Object.assign(Error(code),{code,uncertain})}
export const help=operation=>JSON.stringify({name:'dsbot-hub-admin',usage:'npm run admin -- <operation> < request.json',
 authority:'Explicit Hub administrator/operator only. Bots gain no administrator rights from a group role. Never automatically approve unknown devices.',
 authentication:'Provide DSBOT_HUB_ADMIN_PASSWORD privately in the process environment and DSBOT_HUB_ADMIN_URL as the exact trusted HTTP-loopback/HTTPS admin origin. No credential arguments or config files. Optional DSBOT_HUB_ADMIN_CA_FILE contains public PEM CA certificates only.',
 operations:operation&&fields[operation]?{[operation]:fields[operation]}:fields,
 safety:'No discovery, redirects, TLS bypass or automatic retry. Reconcile state after an uncertain mutation. Approval/rejection and rename/repair require the observed version.',
 lifecycle:'revoke removes device access and active group memberships, revokes unfinished delivery, retains history/principal rows and releases live-principal quota. An inactive owner remains the original owner; other members gain no rights. Explicit repair restores only that same proved device key, is capacity-checked and does not restore group membership. delete permanently removes the exact device identity, contacts, private chats and device-only groups. It requires confirmDelete:true and observed pairing/name versions, closes active sockets, and cannot be repaired. Shared-group history is retained. ownedSharedGroups must list exact conversationId/version pairs from current state: these owned open shared groups are closed, without transferring ownership. A stale group list fails without deletion. Remove a static peer from server configuration before deleting its data. A complete test reset is a separate operation.'},null,2)
export function prepare(operation,input={}){
 if(!Object.hasOwn(fields,operation))fail('UNKNOWN_OPERATION')
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields[operation].includes(key)))fail('INVALID_REQUEST')
 for(const key of fields[operation]){
  const value=input[key]
  if(key.startsWith('expected')){if(!Number.isSafeInteger(value)||value<(key==='expectedNameVersion'?0:1))fail('INVALID_REQUEST')}
  else if(key==='ownedSharedGroups'){if(!Array.isArray(value)||value.some(group=>!group||typeof group!=='object'||Array.isArray(group)||Object.keys(group).sort().join(',')!=='conversationId,version'||typeof group.conversationId!=='string'||!group.conversationId.trim()||!Number.isSafeInteger(group.version)||group.version<1))fail('INVALID_REQUEST')}
  else if(key==='confirmDelete'){if(value!==true)fail('DEVICE_DELETE_CONFIRMATION_REQUIRED')}
  else if(typeof value!=='string'||!value.trim()||value.length>(key==='label'?100:200))fail('INVALID_REQUEST')
 }
 return {operation,path:routes[operation]??operation,input:{...input,...(['approve','reject'].includes(operation)?{action:operation}:{})}}
}
export async function execute(prepared,{url,password,caFile,timeout=15000}={}){
 let base
 try{base=new URL(url)}catch{fail('INVALID_ADMIN_URL')}
 if(base.username||base.password||base.search||base.hash||!['/','/admin/','/admin'].includes(base.pathname))fail('INVALID_ADMIN_URL')
 if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['127.0.0.1','[::1]'].includes(base.hostname)))fail('TLS_REQUIRED')
 if(typeof password!=='string'||password.length<16||password.length>1024)fail('ADMIN_CREDENTIAL_REQUIRED')
 let ca
 if(caFile){ca=await readFile(caFile,'utf8');if(ca.length>20000||!ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)?.length||ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,'').trim())fail('INVALID_CA_FILE')}
 const target=new URL('/admin/api/'+prepared.path,base),data=JSON.stringify(prepared.input)
 const result=await new Promise((resolve,reject)=>{
  const req=(base.protocol==='https:'?httpsRequest:httpRequest)(target,{method:'POST',headers:{origin:base.origin,'content-type':'application/json','content-length':Buffer.byteLength(data),authorization:'Bearer '+password},rejectUnauthorized:true,minVersion:'TLSv1.2',...(ca?{ca}:{})},res=>{
   if(res.statusCode>=300&&res.statusCode<400){res.resume();reject(Object.assign(Error('REDIRECT_REFUSED'),{code:'REDIRECT_REFUSED',uncertain:true}));return}
   let size=0,chunks=[]
   res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){req.destroy();reject(Object.assign(Error('RESPONSE_TOO_LARGE'),{code:'RESPONSE_TOO_LARGE',uncertain:true}))}else chunks.push(chunk)})
   res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(typeof value.ok!=='boolean')throw Error();resolve(value)}catch{reject(Object.assign(Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE',uncertain:true}))}})
  })
  req.setTimeout(timeout,()=>req.destroy(Object.assign(Error('ADMIN_TIMEOUT'),{code:'ADMIN_TIMEOUT',uncertain:true})))
  req.on('error',error=>reject(Object.assign(Error('ADMIN_CONNECTION_FAILED'),{code:'ADMIN_CONNECTION_FAILED',uncertain:true,cause:error})))
  req.end(data)
 })
 if(!result.ok)fail(/^[A-Z][A-Z0-9_]{0,100}$/.test(result.error?.code??'')?result.error.code:'ADMIN_REJECTED')
 if(prepared.operation==='hub-code' && (result.value?.codeError || typeof result.value?.code!=='string' || !result.value.code.startsWith('dsbot-hub:2:')))fail('HUB_V2_MIGRATION_REQUIRED')
 return prepared.operation==='hub-code'?{code:result.value.code,hubId:result.value.hubId,url:result.value.url}:result.value??{revoked:true}
}
export async function main(argv=process.argv.slice(2),env=process.env,stdin=process.stdin,stdout=process.stdout,stderr=process.stderr){
 const [operation,...args]=argv
 if(!operation||operation==='--help'||operation==='help'||args.includes('--help')){stdout.write(help(operation)+'\n');return 0}
 let password,prepared
 const write=(stream,value)=>{let text=JSON.stringify(value);if(password)text=text.split(JSON.stringify(password).slice(1,-1)).join('[REDACTED]');stream.write(text+'\n')}
 try{
  if(args.some(arg=>arg!=='--json'))fail('INVALID_ARGUMENT')
  let source='';if(!stdin.isTTY)for await(const chunk of stdin){source+=chunk;if(source.length>8192)fail('PAYLOAD_TOO_LARGE')}
  let input;try{input=source.trim()?JSON.parse(source):{}}catch{fail('INVALID_JSON')}
  prepared=prepare(operation,input)
  password=env.DSBOT_HUB_ADMIN_PASSWORD;delete env.DSBOT_HUB_ADMIN_PASSWORD
  const value=await execute(prepared,{url:env.DSBOT_HUB_ADMIN_URL,password,caFile:env.DSBOT_HUB_ADMIN_CA_FILE})
  write(stdout,{ok:true,value});return 0
 }catch(error){write(stderr,{ok:false,error:{code:error.code??'ADMIN_FAILURE',uncertain:error.uncertain===true},...(prepared?{request:{operation:prepared.operation,input:prepared.input}}:{})});return error.uncertain?5:2}
 finally{password=undefined}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main()
