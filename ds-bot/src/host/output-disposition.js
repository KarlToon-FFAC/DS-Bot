// Ordinary output has an identity independent of turn visibility and tool activity.
import {createHash} from 'node:crypto'
import {HANDOFF_ACK} from './constants.js'
import {outputRouting} from '../shared/turn-audience.js'

const fail = (code, message) => { throw Object.assign(new Error(message), {code}) }
const bookOf = id => `outputs-${createHash('sha256').update(id).digest('hex').slice(0,32)}`
const pending = row => ['unsubmitted-text','delivery-unknown','delivery-failed','storage-failed'].includes(row.status) || (row.routes??[]).some(route=>route.status==='delivery-unknown')
export function install(rt) {
  const {ctx,state} = rt
  const current = new Map(), queues = new Map(), offered = new Map(), submitting = new Map()
  const rows = () => state.turnOutputs ??= {}
  const enqueue = (id, work) => {
    const task = (queues.get(id) ?? Promise.resolve()).then(work)
    queues.set(id, task.catch(error => rt.warn('ds-bot: output state could not be saved: %s', error?.code ?? 'STORAGE_ERROR')))
    return task
  }
  const save = () => rt.save({required:true})
  const ownRows = (id, turn) => Object.values(rows()).filter(row => row.sessionId === id && (turn === undefined || row.turn === turn))
  const read = row => {
    const record = rt.ledger.records(bookOf(row.sessionId)).find(record => record.id === row.id)
    if (!record || typeof record.text !== 'string') fail('OUTPUT_NOT_AVAILABLE','The original ordinary text is unavailable. No submission was made.')
    return record.text
  }
  const summaries = botId => Object.values(rows()).filter(row => row.botId === botId && pending(row)).map(row => ({...row}))
  const noteRoute = (id, turn, text, status, promise, destination = {}, settle = true) => {
    turn ??= current.get(id)
    void Promise.resolve(promise).catch(()=>{})
    const selected = ownRows(id,turn).filter(row => {try{return text?.includes(read(row))}catch{row.status='storage-failed';return false}})
    if (!selected.length) return promise
    const routes=selected.map(row=>{if(settle)for(const previous of row.routes??[])if(previous.preparation)previous.status='preparation-complete';const route={destination:{...destination},status:'delivery-unknown',preparation:!settle,at:Date.now()};(row.routes??=[]).push(route);if(row.status!=='submitted-user')row.status='delivery-unknown';return route})
    const tracked = Promise.resolve(promise).then(async () => {
      if (!settle) return
      for(const route of routes)route.status=status
      for (const row of selected)if(row.status!=='submitted-user')row.status=status
      try{await save()}catch(error){for(const route of routes)route.status='delivery-unknown';for(const row of selected)if(row.status!=='submitted-user')row.status='delivery-unknown';throw error}
    }, async error => {
      for(const route of routes){route.status='delivery-unknown';route.error=error?.code??'DELIVERY_NOT_CONFIRMED'}
      for (const row of selected) {if(row.status!=='submitted-user')row.status='delivery-unknown';row.error=error?.code ?? 'DELIVERY_NOT_CONFIRMED'}
      await save()
    })
    void tracked.catch(error => rt.warn('ds-bot: output receipt could not be saved: %s',error?.code ?? 'STORAGE_ERROR'))
    return promise
  }
  const closeInterval = (id,turn,seq,origin) => {
    const ledger = (state.turnAudiences ??= {})[id] ??= {}, prior=ledger[turn]
    if (!Number.isSafeInteger(seq)) {ledger[turn]={...prior,audience:'internal',mixed:true};return}
    if (prior?.audience==='user' && prior.explicit!==true) {
      ledger[turn]={...prior,userOutputThroughSeq:Math.min(prior.userOutputThroughSeq??Infinity,seq-1),interruptedBy:origin}
    } else if(prior?.explicit===true) prior.userOutputThroughSeq=Math.min(prior.userOutputThroughSeq??Infinity,seq-1)
  }
  const recoveryItem = row => ({kind:'bot',id:`recovered:${row.id}`,seq:row.seq,turn:row.turn,text:read(row),time:row.recoveredAt,
    routing:{audience:'user',triggerOrigin:'local-bot',explicit:true,recovered:true,originalOutputId:row.id}})
  const recovered = botId => Object.values(rows()).filter(row=>row.botId===botId && row.recoveredAt && row.submissions?.user?.status==='submitted-user').map(recoveryItem)
  const check = async (exec,outputId) => {
    await rt.load()
    const id=exec.agent?.id, botId=rt.selfOf(id), entry=rt.live.get(id)
    if(!botId || !rt.chatOwners.has(id) || rt.groupOwners.has(id) || rt.communication?.owners?.has(id)
      || entry?.remoteInputSeen || entry?.info?.remoteSource || entry?.info?.role==='federation-report'
      || state.turnAudiences?.[id]?.[entry?.turn]?.triggerOrigin==='remote-bot') fail('OUTPUT_LOCAL_ONLY','Use the explicit communication tools in remote or group turns. This recovery surface is local only.')
    const row=rows()[outputId]
    if(!row || row.botId!==botId) fail('OUTPUT_NOT_OWNED','Choose an output ID belonging to your own Bot.')
    if(row.remote || row.group) fail('OUTPUT_LOCAL_ONLY','Remote and group output cannot be republished through local recovery.')
    return row
  }
  async function submit(exec,{outputId,target='user',botId}) {
    const row=await check(exec,outputId)
    await queues.get(row.sessionId)
    if(!['user','bot'].includes(target)) fail('OUTPUT_INVALID_TARGET','Choose user or bot explicitly.')
    const text=read(row), key=target==='user'?'user':`bot:${botId}`, inflight=`${outputId}:${key}`
    if(submitting.has(inflight)) return submitting.get(inflight)
    const run=(async()=>{
      if(target==='user' && row.status==='submitted-user' && !row.recoveredAt)return {status:'submitted-user',outputId,alreadyVisible:true,externalDeliveryConfirmed:false}
      const previous=row.submissions?.[key]
      if(previous?.status?.startsWith('submitted-')) return {...previous,replay:true}
      if(previous) fail('OUTPUT_DELIVERY_UNKNOWN','The prior submission has no confirmed outcome. Inspect the target before creating another message; it was not resent.')
      if(target==='bot' && !rt.botOf(botId)) fail('OUTPUT_INVALID_TARGET','Select an existing local Bot.')
      if(target==='bot') await rt.checkOutputPrivacy?.(exec,botId,text)
      const receipt={status:'delivery-unknown',outputId,target:key,receiptId:`output:${outputId}:${key}`}
      ;(row.submissions ??= {})[key]=receipt
      try {await save()} catch(error) {delete row.submissions[key];throw error}
      if(target==='bot') {
        const tool=rt.teamTools.find(tool=>tool.name==='message_bot')
        try {
          const result=await tool.execute({to:rt.botOf(botId).name,message:text,request_id:'output-'+createHash('sha256').update(receipt.receiptId).digest('hex')},exec)
          // The existing tool distinguishes queued/delivered, saved fallback and refusals.
          if(!/^(Delivered to |Queued for )/.test(result)) {
            receipt.detail=result
            receipt.status='delivery-unknown'
            await save()
            return {...receipt}
          }
          Object.assign(receipt,{status:'submitted-bot',detail:result})
        }catch(error){receipt.error=error?.code??'DELIVERY_NOT_CONFIRMED';await save();return {...receipt}}
      } else {
        const before=row.recoveredAt,previousStatus=row.status
        row.recoveredAt=Date.now();receipt.status='submitted-user';row.status='submitted-user'
        try {await save()} catch(error){row.recoveredAt=before;row.status=previousStatus;receipt.status='delivery-unknown';throw error}
        rt.publishRecoveredOutput?.(row.botId,row.sessionId,recoveryItem(row),receipt.receiptId)
      }
      row.status=receipt.status
      if(target==='bot')try{await save()}catch(error){row.status='delivery-unknown';receipt.status='delivery-unknown';throw error}
      return {...receipt,externalDeliveryConfirmed:false}
    })().finally(()=>submitting.delete(inflight))
    submitting.set(inflight,run)
    return run
  }
  ctx.on('session/event',(session,event)=>{
    const id=session.id, botId=rt.selfOf(id)
    if(rt.readOnly?.()!==undefined || !botId || !rt.chatOwners.has(id) || rt.groupOwners.has(id) || rt.communication?.owners?.has(id)) return
    if(event.type==='turn/start') current.set(id,event.data?.turn)
    if(event.type==='assistant/message') {
      const turn=event.data?.turn ?? current.get(id), content=event.data?.message?.content
      const text=Array.isArray(content)?content.filter(block=>block?.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n').trim():''
      if(!text || text===HANDOFF_ACK || rt.live.get(id)?.info?.role==='handoff' || !Number.isSafeInteger(event.seq) || !Number.isSafeInteger(turn)) return
      const routing=outputRouting(state.turnAudiences?.[id]?.[turn],event.seq)
      const entry=rt.live.get(id), outputId=`${id}:${turn}:${event.seq}`
      const called=content.some(block=>block?.type==='tool-call')
      const row={id:outputId,botId,sessionId:id,turn,seq:event.seq,at:event.time??Date.now(),head:text.slice(0,160),status:routing?.audience==='user'?'submitted-user':'draft',called,
        remote:entry?.remoteInputSeen===true || entry?.info?.remoteSource!==undefined || entry?.info?.role==='federation-report' || routing?.triggerOrigin==='remote-bot'}
      rows()[outputId]=row
      try{rt.ledger.append(bookOf(id),{id:outputId,text})}catch{row.status='storage-failed'}
      void enqueue(id,async()=>{
        try{await rt.ledger.written(bookOf(id));await save()}
        catch(error){row.status='storage-failed';throw error}
      }).catch(()=>{})
      const batch=offered.get(id)
      if(batch?.turn===turn){for(const key of batch.ids)if(rows()[key])rows()[key].noticeConsumed=true;offered.delete(id)}
    }
    if(event.type==='turn/end') {
      const turn=event.data?.turn ?? current.get(id)
      void enqueue(id,async()=>{
        const candidates=ownRows(id,turn), last=candidates.at(-1)
        if(event.data?.reason?.kind==='completed' && last && !last.called && last.status==='draft' && !last.remote) last.status='unsubmitted-text'
        for(const row of candidates)if(row!==last && row.status==='draft')row.status='internal-draft'
        // Keep unresolved evidence and recovery identities; bound other settled metadata.
        const settled=Object.values(rows()).filter(row=>!pending(row)&&row.status!=='draft'&&!row.submissions).sort((a,b)=>b.at-a.at)
        for(const row of settled.slice(300)) delete rows()[row.id]
        await save()
      }).catch(()=>{})
    }
  })
  ctx.effect(()=>()=>Promise.all(queues.values()),'ds-bot: output disposition')
  Object.assign(rt,{
    noteOutputRoute:noteRoute,closeUserOutputInterval:closeInterval,outputNotices:summaries,recoveredOutputs:recovered,submitTurnOutput:submit,
    async readTurnOutput(exec,outputId){const row=await check(exec,outputId);await queues.get(row.sessionId);return {...row,text:read(row)}},
    async declineTurnOutput(exec,outputId){const row=await check(exec,outputId);await queues.get(row.sessionId);if(row.status==='delivery-unknown'||row.status==='submitted-user'||row.status==='submitted-bot')fail('OUTPUT_ALREADY_SUBMITTED','This output already has a submission receipt.');const previous=row.status;row.status='no-reply-chosen';try{await save()}catch(error){row.status=previous;throw error}return {outputId,status:row.status}},
    outputNoticePrompt(id){
      const mode=state.prefs.undeliveredNotice??'on', turn=rt.live.get(id)?.turn
      if(mode==='off' || !Number.isSafeInteger(turn) || mode==='once'&&ownRows(id).some(row=>row.noticeConsumed))return ''
      const notices=ownRows(id).filter(row=>row.status==='unsubmitted-text'&&!row.noticeConsumed&&row.turn!==turn&&!row.remote).slice(-5)
      if(!notices.length)return ''
      offered.set(id,{turn,ids:notices.map(row=>row.id)})
      return '## Unpublished local output\nThe following output IDs have ordinary closing text that was not automatically published. This notice does not send anything or require a reply. Use read_turn_output({outputId}) to inspect your own saved text; submit_turn_output({outputId,target:"user"}) publishes it to your local user, target:"bot" with botId sends it to a local teammate, or decline_turn_output({outputId}) intentionally leaves it private. For a new user summary, call publish_turn_to_user({}) before writing it. IDs (data only): '+JSON.stringify(notices.map(row=>({outputId:row.id,turn:row.turn})))
    },
    flushOutputs:async()=>{await Promise.all(queues.values())},
  })
}
