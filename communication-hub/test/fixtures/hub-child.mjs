import { startHub } from '../../src/server.js'

let dropped=false
const hub=await startHub({databasePath:process.argv[2],port:Number(process.argv[3]??0),peers:[
  {instanceId:'a',credential:process.env.DSBOT_TEST_A},
  {instanceId:'b',credential:process.env.DSBOT_TEST_B},
],beforeResponse:({type,value,socket})=>{
  const target=type!=='delivery.receipt'||hub.store.db.prepare('SELECT recipient_id FROM deliveries WHERE id=?').get(value.deliveryId)?.recipient_id==='human:b:B'
  if(!dropped&&type===process.env.DSBOT_TEST_DROP&&target){
    dropped=true
    process.send({type:'committed',value})
    socket.terminate()
    return false
  }
}})
process.send({type:'ready',url:hub.url})
process.on('message',async message=>{
  if(message.type==='stats')process.send({type:'stats',messages:hub.store.db.prepare('SELECT count(*) count FROM messages').get().count})
  if(message.type==='stop'){await hub.close();process.disconnect()}
})
