// Opt-in for this isolated test only; no service or machine-wide process control.
export function watchOwnedParent() {
  const reference=process.env.DSBOT_COMMUNICATION_OWNER_PID
  if(reference===undefined)return
  if(!/^[1-9][0-9]{0,9}$/.test(reference))throw new Error('INVALID_OWNED_PARENT')
  const owner=Number(reference),deadline=Date.now()+15*60*1000
  const timer=setInterval(()=>{
    try{process.kill(owner,0)}catch{process.exit(0)}
    if(Date.now()>=deadline)process.exit(0)
  },500)
  timer.unref()
}
