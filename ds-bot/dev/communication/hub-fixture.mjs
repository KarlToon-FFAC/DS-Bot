// Independent real Hub process; fault controls exist only on its parent IPC pipe.
import { writeFileSync } from 'node:fs'
import { startHub } from '../../../communication-hub/src/server.js'
import { CommunicationError } from '../../../communication-hub/src/protocol.js'

const peers=JSON.parse(process.env.DSBOT_TEST_PEERS)
delete process.env.DSBOT_TEST_PEERS
let armed=null,activeRequest=null
const sockets=new Map()
const checkpoint=(point,extra={})=>{
  const value={point,...extra}
  writeFileSync(process.argv[4],JSON.stringify(value))
  process.send?.({type:'checkpoint',value})
}
const hub=await startHub({databasePath:process.argv[2],port:Number(process.argv[3]),peers,
  beforeRequest:request=>{activeRequest=request;if(armed?.point==='reject-publish-once'&&request.type==='message.publish'&&request.payload.author?.principalId===armed.principalId){armed=null;throw new CommunicationError('TARGET_NOT_RECEIVING')}if(armed?.point==='deny-publish'&&request.type==='message.publish'&&request.payload.author?.principalId===armed.principalId)throw new CommunicationError('STORAGE_UNAVAILABLE')},
  beforeCommit:()=>{
    if(armed?.point!=='before-commit-crash'||activeRequest?.type!=='message.publish')return
    checkpoint(armed.point,{messageId:activeRequest.payload.messageId});armed=null
    process.kill(process.pid,'SIGKILL')
  },
  beforeResponse:({type,value,socket})=>{
    if(type==='hello')sockets.set(value.instanceId,socket)
    if(!armed)return
    if(type==='message.publish'&&['after-commit-crash','drop-ack'].includes(armed.point)){
      const point=armed.point;armed=null;checkpoint(point,{messageId:value.messageId,conversationSeq:value.conversationSeq,socketOpen:socket.readyState===1})
      if(point==='after-commit-crash')process.kill(process.pid,'SIGKILL')
      return false
    }
    if(type==='conversation.sync'&&armed.point==='history-gap'&&activeRequest.payload.principalId===armed.principalId
      &&activeRequest.payload.conversationId===armed.conversationId){
      value.events=value.events.filter(event=>event.message?.messageId!==armed.messageId).reverse()
      checkpoint(armed.point,{messageId:armed.messageId,principalId:armed.principalId})
    }
    if(type==='hello'&&armed.point==='disconnect'&&value.instanceId===armed.instanceId){socket.close();armed=null}
  }})
process.on('message',async message=>{
  try{
    let value
    if(message.command==='arm'){armed=message.value;value={armed:true}}
    else if(message.command==='clear'){armed=null;value={cleared:true}}
    else if(message.command==='disconnect'){sockets.get(message.value.instanceId)?.close(1001,'Local recovery test');value={disconnected:true}}
    else if(message.command==='stats')value={messages:hub.store.db.prepare('SELECT id,conversation_id,seq,author_id,body FROM messages').all(),
      deliveries:hub.store.db.prepare('SELECT * FROM deliveries').all(),responses:hub.store.db.prepare('SELECT * FROM responses').all(),instances:hub.store.db.prepare('SELECT id,epoch FROM instances').all()}
    else if(message.command==='close'){await hub.close();process.send?.({id:message.id,ok:true,value:{closed:true}});process.exit(0)}
    else throw new Error('Unknown fixture command')
    process.send?.({id:message.id,ok:true,value})
  }catch{process.send?.({id:message.id,ok:false})}
})
process.send?.({type:'ready',url:hub.url})
process.once('disconnect',()=>{void hub.close().finally(()=>process.exit(0))})
