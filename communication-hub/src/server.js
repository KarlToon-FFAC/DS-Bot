import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { HubStore } from './store.js'
import { COMMUNICATION_VERSION } from './version.js'
import { HubManagement } from './management-store.js'
import { createManagementHttp } from './management-http.js'
import { CommunicationError, PROTOCOL, identifier, requireThat } from './protocol.js'

const loopback = host => ['127.0.0.1','::1'].includes(host)
const digest = value => createHash('sha256').update(value).digest()
// Hints never carry conversation IDs, membership data or content. All reads still
// pass through the authenticated RPC routes and durable per-membership cursors.
const invalidatingRoutes = new Set(['principal.register', 'principal.rename', 'principal.publication', 'principal.public-profile', 'principal.avatar.chunk',
  'dm.open', 'group.create', 'group.invite', 'group.accept', 'group.remove', 'group.routing', 'group.dissolve',
  'group.policy', 'group.transfer', 'group.configure', 'group.settings', 'message.publish',
  'principal.profile', 'contact.code.rotate', 'contact.request', 'contact.accept', 'contact.reject', 'contact.cancel', 'contact.revoke', 'contact.use-published-bots'])
const routes = {
  'principal.register':'register', 'contacts.list':'contacts', 'dm.open':'createDm', 'group.create':'createGroup',
  'group.invite':'invite', 'group.accept':'accept', 'group.remove':'remove', 'group.routing':'routing', 'group.dissolve':'dissolve',
  'group.policy':'policy', 'group.transfer':'transfer', 'principal.rename':'renameHuman', 'group.configure':'configureGroup', 'group.settings':'settings',
  'collection.status':'collectionStatus', 'message.publish':'publish', 'memberships.list':'memberships', 'conversation.sync':'sync', 'conversation.authorize':'authorize', 'conversation.members':'members',
  'conversation.ack':'acknowledgeCursor', 'deliveries.pull':'pending', 'delivery.receipt':'receipt', 'message.status':'deliveryStatus',
  'principal.avatar.begin':'avatarBegin', 'principal.avatar.chunk':'avatarChunk', 'principal.avatar.read':'avatarRead', 'principal.profile':'profile',
  'principal.publication':'syncPublication',
  'principal.public-profile':'updatePublicProfile',
  'principal.public-profile.read':'readPublicProfile',
}

export async function startHub({ databasePath, databaseLock, peers, host='127.0.0.1', port=3190, tls, limits, management:managementOptions, beforeCommit, beforeRequest, beforeResponse, heartbeatMs=30000 }={}) {
  requireThat(loopback(host)||tls?.key&&tls?.cert,'TLS_REQUIRED','Non-loopback listeners require TLS')
  requireThat(Number.isInteger(port)&&port>=0&&port<=65535,'INVALID_CONFIG')
  requireThat(Number.isSafeInteger(heartbeatMs)&&heartbeatMs>=10,'INVALID_CONFIG')
  const allowed=new Map()
  for(const peer of peers??[]){
    identifier(peer.instanceId)
    requireThat(!peer.instanceId.includes(':')&&!allowed.has(peer.instanceId)&&typeof peer.credential==='string'&&peer.credential.length>=32,'INVALID_CONFIG')
    allowed.set(peer.instanceId,{credentialHash:digest(peer.credential),label:peer.instanceLabel??peer.instanceId,pairingRevision:peer.pairingRevision??1})
  }
  const store=new HubStore(databasePath,{limits,beforeCommit,databaseLock})
  try {
  const pairingTrust=managementOptions?.pairingCa ? { caPem:String(managementOptions.pairingCa), certificatePem:String(tls?.cert??''), privateKey:tls?.key } : undefined
  requireThat(!managementOptions?.enabled || !tls || pairingTrust, 'HUB_V2_MIGRATION_REQUIRED')
  const management=new HubManagement(store,{url:managementOptions?.url??managementOptions?.publicUrl,pairingTrust})
  const configuredPeers=new Set(allowed.keys())
  management.isConfiguredPeer=id=>configuredPeers.has(id)
  store.directoryFilter=(auth,rows,principalId)=>management.filterDirectory(auth,rows,principalId)
  store.contactPolicy=(auth,actorId,targetId)=>management.assertContact(auth,actorId,targetId)
  store.dmPolicy=id=>management.assertDm(id)
  store.ownerInvitationPolicy=(actorId,targetId)=>management.canContact(actorId,targetId)
  try{
    requireThat(allowed.size>0||managementOptions?.enabled===true||store.db.prepare('SELECT 1 FROM hub_enrolled_peers LIMIT 1').get(),'INVALID_CONFIG','Configure paired instances or explicitly enable Hub management')
    for(const [id,peer] of allowed)store.configurePeer(id,peer.label,peer.pairingRevision)
    for(const instance of store.db.prepare('SELECT id FROM instances WHERE trusted=1').all())if(!allowed.has(instance.id)&&!management.peer(instance.id))store.revokeInstance(instance.id)
    store.groupJoinRepair=store.repairGroupJoins()
    if(managementOptions?.enabled)requireThat(typeof managementOptions.password==='string'||store.db.prepare("SELECT 1 FROM hub_management WHERE key='adminVerifier'").get(),'INVALID_CONFIG','Configure a private administrator password before enabling management')
  }catch(error){store.close();throw error}
  let managementHttp, managementUrl = null
  const server=(tls?createHttpsServer: createHttpServer)(...(tls?[{key:tls.key,cert:tls.cert,minVersion:'TLSv1.2'}]:[]),async(_req,res)=>{
    try{
    if(await managementHttp?.handle(_req,res))return
    if(_req.method==='GET'&&_req.url==='/health'){
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
      res.end(JSON.stringify({ok:true,protocol:PROTOCOL}))
    }else{res.writeHead(404);res.end()}
    }catch{if(!res.headersSent)res.writeHead(500,{'cache-control':'no-store'});res.end()}
  })
  const sockets=new WebSocketServer({server,path:'/communication',maxPayload:store.limits.maxEnvelopeBytes,perMessageDeflate:false})
  const connections=new Set()
  const alive=new WeakSet()
  const heartbeat=setInterval(()=>{
    for(const socket of connections){
      if(!alive.has(socket)){socket.terminate();continue}
      alive.delete(socket)
      if(socket.readyState===1)socket.ping()
    }
  },heartbeatMs)
  heartbeat.unref()
  const identities=new Map()
  const subscribers=new Map()
  const authenticated=new Map()
  management.isInstanceConnected=instanceId=>{
    for(const [socket,auth] of authenticated){
      if(auth.instanceId!==instanceId||socket.readyState!==1)continue
      try{store.check(auth);return true}catch{/* Stale epochs are never online. */}
    }
    return false
  }
  store.isInstanceConnected=management.isInstanceConnected
  let invalidationTimer, directoryDirty=false, closing=false
  const invalidate=(scope='directory')=>{
    if(closing)return
    if(scope!=='messages')directoryDirty=true
    if(invalidationTimer)return
    invalidationTimer=setTimeout(()=>{
      invalidationTimer=null
      const scope=directoryDirty?'directory':'messages'
      directoryDirty=false
      for(const [socket,auth] of subscribers){
        if(socket.readyState!==1||socket.bufferedAmount>=store.limits.maxEnvelopeBytes)continue
        try{store.check(auth);socket.send(JSON.stringify({protocol:PROTOCOL,type:'state.invalidate',scope}))}catch{/* Revoked peers receive no hints. */}
      }
    },50)
    invalidationTimer.unref()
  }
  const changed=()=>{if(managementHttp?.changed)managementHttp.changed();else invalidate()}
  sockets.on('connection',(socket,request)=>{
    if(connections.size>=64){socket.close(1013,'Connection capacity reached');return}
    connections.add(socket)
    alive.add(socket)
    socket.on('pong',()=>alive.add(socket))
    let auth=null
    const deadline=setTimeout(()=>socket.close(1008,'Authentication required'),5000)
    deadline.unref()
    socket.on('close',()=>{clearTimeout(deadline);connections.delete(socket);identities.delete(socket);management.forget(socket);subscribers.delete(socket);authenticated.delete(socket);if(auth)changed()})
    socket.on('error',()=>{})
    socket.on('message',(data,isBinary)=>{
      let id=null
      try{
        requireThat(!isBinary,'UNSUPPORTED_CONTENT')
        let frame
        try{frame=JSON.parse(data.toString('utf8'))}catch{throw new CommunicationError('INVALID_REQUEST')}
        requireThat(frame&&typeof frame==='object'&&!Array.isArray(frame),'INVALID_REQUEST')
        id=identifier(frame.id)
        requireThat(frame.protocol===PROTOCOL,'PROTOCOL_VERSION_UNSUPPORTED')
        requireThat(frame.payload&&typeof frame.payload==='object'&&!Array.isArray(frame.payload),'INVALID_REQUEST')
        let value, enrollmentPurpose
        if(!auth){
          if(frame.type==='enrollment.challenge'){
            requireThat(frame.payload.purpose!=='join'||managementHttp?.enabled,'MANAGEMENT_DISABLED')
            value=management.challenge(socket,frame.payload,request.socket.remoteAddress??'unknown')
          }else if(frame.type==='enrollment.prove'){
            enrollmentPurpose=management.challenges.get(frame.payload.challengeId)?.purpose
            const proof=management.prove(socket,frame.payload)
            if(proof.instanceId&&proof.label!==undefined){
              value=store.connect(proof.instanceId,proof.label,frame.payload.capabilities)
              auth={instanceId:value.instanceId,epoch:value.epoch}
            }else value=proof
          }else{
          requireThat(frame.type==='hello','UNAUTHENTICATED')
          const peer=allowed.get(frame.payload?.instanceId)
          requireThat(peer&&!management.peer(frame.payload.instanceId)&&typeof frame.payload.credential==='string'&&timingSafeEqual(peer.credentialHash,digest(frame.payload.credential)),'UNAUTHENTICATED')
          value=store.connect(frame.payload.instanceId,peer.label,frame.payload.capabilities)
          auth={instanceId:value.instanceId,epoch:value.epoch}
          }
          if(auth){
          store.observeAddress(auth,(request.socket.remoteAddress??'unknown').replace(/^::ffff:/,''))
          identities.set(socket,auth.instanceId)
          authenticated.set(socket,{...auth})
          if(frame.payload.capabilities?.includes('state-invalidation'))subscribers.set(socket,{...auth})
          clearTimeout(deadline)
          changed()
          }
        }else{
          requireThat(allowed.has(auth.instanceId)||management.peer(auth.instanceId),'UNAUTHENTICATED')
          store.check(auth)
          const contactRoutes={'contact.code':'code','contact.code.rotate':'rotateCode','contact.request':'requestContact','contact.requests':'contactRequests','contact.relations':'relations',
            'contact.accept':'accept','contact.reject':'reject','contact.cancel':'cancel','contact.revoke':'revokeContact','contact.use-published-bots':'usePublishedBots'}
          const contact=contactRoutes[frame.type]
          if(contact){
            value=['accept','reject','cancel'].includes(contact)?management.respondContact(auth,frame.payload,contact):management[contact](auth,frame.payload)
          }else{
          const method=Object.hasOwn(routes,frame.type)?routes[frame.type]:null
          requireThat(method,'UNKNOWN_OPERATION')
          beforeRequest?.({type:frame.type,payload:frame.payload})
          value=store[method](auth,frame.payload)
          }
        }
        if(frame.type==='message.publish')invalidate('messages')
        else if(invalidatingRoutes.has(frame.type)||['join','cancel','leave'].includes(enrollmentPurpose))changed()
        if(beforeResponse?.({type:frame.type,value,socket})===false)return
        if(auth&&(frame.type==='hello'||frame.type==='enrollment.prove'))value={...value,hubId:management.hubId,...(managementUrl?{managementUrl}:{})}
        requireThat(socket.bufferedAmount<store.limits.maxEnvelopeBytes*4,'BACKPRESSURE')
        const response=JSON.stringify({id,ok:true,value})
        requireThat(Buffer.byteLength(response)<=store.limits.maxEnvelopeBytes,'PAYLOAD_TOO_LARGE')
        socket.send(response)
        if(frame.type==='enrollment.prove'&&value?.left===true){
          for(const [peer,id] of identities)if(id===value.instanceId)peer.close(1008,'Trust revoked')
        }
      }catch(error){
        const known=error instanceof CommunicationError
        const compatibility = known && ['PROTOCOL_VERSION_UNSUPPORTED','UNSUPPORTED_CAPABILITY','EXPLICIT_ACTIVATION_REQUIRED','ATTACHMENT_CAPABILITY_REQUIRED'].includes(error.code)
          ? { compatibility: { protocol: PROTOCOL, communicationVersion: COMMUNICATION_VERSION, updateTarget: error.code === 'PROTOCOL_VERSION_UNSUPPORTED' ? 'both' : 'client' } } : {}
        if(socket.readyState===1)socket.send(JSON.stringify({id,ok:false,error:{code:known?error.code:'STORAGE_UNAVAILABLE',message:known?error.message:'Communication request could not be committed',...(known&&(error.details||compatibility.compatibility)?{details:{...error.details,...compatibility}}:{})}}))
        if(!auth)socket.close(1008,'Handshake rejected')
      }
    })
  })
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)})
  }catch(error){clearInterval(heartbeat);sockets.close();store.close();throw error}
  const address=server.address()
  const url=`${tls?'wss':'ws'}://${host.includes(':')?`[${host}]`:host}:${address.port}/communication`
  const revoke=instanceId=>{allowed.delete(instanceId);const value=store.revokeInstance(instanceId);for(const [socket,id] of identities)if(id===instanceId)socket.close(1008,'Trust revoked');changed();return value}
  const deleteInstance=input=>{const value=management.delete(input);for(const [socket,id] of identities)if(id===input.instanceId)socket.close(1008,'Device deleted');changed();return value}
  if(managementOptions?.enabled){
    try{
      management.url??=url
      if(pairingTrust)management.info()
      const origin=managementOptions.origin??new URL(management.url.replace(/^ws/,'http')).origin
      managementHttp=createManagementHttp(management,{password:managementOptions.password,origin,onRevoke:revoke,onDelete:deleteInstance,onChange:invalidate})
      if(managementHttp.enabled)managementUrl=`${origin}/admin/`
    }catch(error){clearInterval(heartbeat);closing=true;clearTimeout(invalidationTimer);for(const socket of connections)socket.terminate();await new Promise(resolve=>sockets.close(resolve));await new Promise(resolve=>server.close(resolve));store.close();throw error}
  }
  return {store,management,host,port:address.port,url,managementUrl,
    revoke,deleteInstance,
    async close(){closing=true;clearInterval(heartbeat);clearTimeout(invalidationTimer);managementHttp?.close();for(const socket of connections)socket.terminate();await new Promise(resolve=>sockets.close(resolve));await new Promise(resolve=>server.close(resolve));store.close()}}
  } catch(error) { store.close(); throw error }
}
