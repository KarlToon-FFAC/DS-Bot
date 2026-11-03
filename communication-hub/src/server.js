import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { HubStore } from './store.js'
import { CommunicationError, PROTOCOL, identifier, requireThat } from './protocol.js'

const loopback = host => ['127.0.0.1','::1'].includes(host)
const digest = value => createHash('sha256').update(value).digest()
const routes = {
  'principal.register':'register', 'contacts.list':'contacts', 'dm.open':'createDm', 'group.create':'createGroup',
  'group.invite':'invite', 'group.accept':'accept', 'group.remove':'remove', 'group.routing':'routing', 'group.dissolve':'dissolve',
  'group.policy':'policy', 'group.transfer':'transfer', 'group.reclaim':'reclaim',
  'message.publish':'publish', 'memberships.list':'memberships', 'conversation.sync':'sync', 'conversation.authorize':'authorize', 'conversation.members':'members',
  'conversation.ack':'acknowledgeCursor', 'deliveries.pull':'pending', 'delivery.receipt':'receipt', 'message.status':'deliveryStatus',
}

export async function startHub({ databasePath, peers, host='127.0.0.1', port=3190, tls, limits, beforeCommit, beforeRequest, beforeResponse }={}) {
  requireThat(loopback(host)||tls?.key&&tls?.cert,'TLS_REQUIRED','Non-loopback listeners require TLS')
  requireThat(Number.isInteger(port)&&port>=0&&port<=65535,'INVALID_CONFIG')
  const allowed=new Map()
  for(const peer of peers??[]){
    identifier(peer.instanceId)
    requireThat(!peer.instanceId.includes(':')&&!allowed.has(peer.instanceId)&&typeof peer.credential==='string'&&peer.credential.length>=32,'INVALID_CONFIG')
    allowed.set(peer.instanceId,{credentialHash:digest(peer.credential),label:peer.instanceLabel??peer.instanceId,pairingRevision:peer.pairingRevision??1})
  }
  requireThat(allowed.size>0,'INVALID_CONFIG','Configure at least one explicitly paired instance')
  const store=new HubStore(databasePath,{limits,beforeCommit})
  try{
    for(const [id,peer] of allowed)store.configurePeer(id,peer.label,peer.pairingRevision)
    for(const instance of store.db.prepare('SELECT id FROM instances WHERE trusted=1').all())if(!allowed.has(instance.id))store.revokeInstance(instance.id)
  }catch(error){store.close();throw error}
  const server=(tls?createHttpsServer: createHttpServer)(...(tls?[{key:tls.key,cert:tls.cert,minVersion:'TLSv1.2'}]:[]),(_req,res)=>{
    if(_req.method==='GET'&&_req.url==='/health'){
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'})
      res.end(JSON.stringify({ok:true,protocol:PROTOCOL}))
    }else{res.writeHead(404);res.end()}
  })
  const sockets=new WebSocketServer({server,path:'/communication',maxPayload:store.limits.maxEnvelopeBytes,perMessageDeflate:false})
  const connections=new Set()
  const identities=new Map()
  sockets.on('connection',socket=>{
    if(connections.size>=64){socket.close(1013,'Connection capacity reached');return}
    connections.add(socket)
    let auth=null
    const deadline=setTimeout(()=>socket.close(1008,'Authentication required'),5000)
    deadline.unref()
    socket.on('close',()=>{clearTimeout(deadline);connections.delete(socket);identities.delete(socket)})
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
        let value
        if(!auth){
          requireThat(frame.type==='hello','UNAUTHENTICATED')
          const peer=allowed.get(frame.payload?.instanceId)
          requireThat(peer&&typeof frame.payload.credential==='string'&&timingSafeEqual(peer.credentialHash,digest(frame.payload.credential)),'UNAUTHENTICATED')
          value=store.connect(frame.payload.instanceId,peer.label,frame.payload.capabilities)
          auth={instanceId:value.instanceId,epoch:value.epoch}
          identities.set(socket,auth.instanceId)
          clearTimeout(deadline)
        }else{
          requireThat(allowed.has(auth.instanceId),'UNAUTHENTICATED')
          const method=Object.hasOwn(routes,frame.type)?routes[frame.type]:null
          requireThat(method,'UNKNOWN_OPERATION')
          beforeRequest?.({type:frame.type,payload:frame.payload})
          value=store[method](auth,frame.payload)
        }
        if(beforeResponse?.({type:frame.type,value,socket})===false)return
        requireThat(socket.bufferedAmount<store.limits.maxEnvelopeBytes*4,'BACKPRESSURE')
        const response=JSON.stringify({id,ok:true,value})
        requireThat(Buffer.byteLength(response)<=store.limits.maxEnvelopeBytes,'PAYLOAD_TOO_LARGE')
        socket.send(response)
      }catch(error){
        const known=error instanceof CommunicationError
        if(socket.readyState===1)socket.send(JSON.stringify({id,ok:false,error:{code:known?error.code:'STORAGE_UNAVAILABLE',message:known?error.message:'Communication request could not be committed',...(known&&error.details?{details:error.details}:{})}}))
        if(!auth)socket.close(1008,'Handshake rejected')
      }
    })
  })
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)})
  }catch(error){sockets.close();store.close();throw error}
  const address=server.address()
  return {store,host,port:address.port,url:`${tls?'wss':'ws'}://${host.includes(':')?`[${host}]`:host}:${address.port}/communication`,
    revoke(instanceId){allowed.delete(instanceId);const value=store.revokeInstance(instanceId);for(const [socket,id] of identities)if(id===instanceId)socket.close(1008,'Trust revoked');return value},
    async close(){for(const socket of connections)socket.terminate();await new Promise(resolve=>sockets.close(resolve));await new Promise(resolve=>server.close(resolve));store.close()}}
}
