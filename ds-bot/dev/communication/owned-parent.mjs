// Opt-in for this isolated test only; no service or machine-wide process control.
export function watchOwnedParent() {
  const reference=process.env.DSBOT_COMMUNICATION_OWNER_PID
  if(reference===undefined)return
  if(!/^[1-9][0-9]{0,9}$/.test(reference))throw new Error('INVALID_OWNED_PARENT')
  const duration=process.env.DSBOT_COMMUNICATION_TEST_LIFETIME_MS===undefined?15*60*1000:Number(process.env.DSBOT_COMMUNICATION_TEST_LIFETIME_MS)
  if(!Number.isSafeInteger(duration)||duration<60000||duration>4*60*60*1000)throw new Error('INVALID_OWNED_LIFETIME')
  const owner=Number(reference),deadline=Date.now()+duration
  const timer=setInterval(()=>{
    try{process.kill(owner,0)}catch{process.exit(0)}
    if(Date.now()>=deadline)process.exit(0)
  },500)
  timer.unref()
}
