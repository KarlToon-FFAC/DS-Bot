// Ordinary output has an identity independent of turn visibility and tool activity.
import {createHash} from 'node:crypto'
import {migrateOutput,addVisibility as addVisibilityFact,isUserSubmitted,outputPending,settleOutput,deliveryConfirmed,OUTPUT_SCHEMA} from './output-records.js'
import {absoluteLinks} from './links.js'
import {HANDOFF_ACK} from './constants.js'
import {userOutputDecision} from '../shared/user-output-policy.js'
import {outputRouting} from '../shared/turn-audience.js'

const fail = (code, message) => { throw Object.assign(new Error(message), {code}) }
const bookOf = id => `outputs-${createHash('sha256').update(id).digest('hex').slice(0,32)}`
const pending = row => Boolean(row.pending) || ['delivery-unknown','delivery-failed','storage-failed'].includes(row.status) || (row.deliveries??[]).some(route=>route.status==='delivery-unknown')
export function install(rt) {
  const {ctx,state} = rt
  const journalVisibility=(row,fact)=>rt.ledger.append(bookOf(row.sessionId),{event:'visibility',outputId:row.id,...fact})
  const addVisibility=(row,fact,journal=true)=>{
    const exists=row.visibility?.some(old=>old.id===fact.id)
    addVisibilityFact(row,fact)
    if(!exists&&journal)journalVisibility(row,{...fact,audience:'user'})
  }
  const journalDelivery=(row,route)=>rt.ledger.append(bookOf(row.sessionId),{event:'output-delivery',outputId:row.id,...route})
  const current = new Map(), queues = new Map(), offered = new Map(), submitting = new Map(), routeTasks=new Set()
  const trackRoute=promise=>{const task=Promise.resolve(promise).catch(()=>{});routeTasks.add(task);void task.finally(()=>routeTasks.delete(task));return task}
  const flush=async()=>{for(;;){const batch=[...queues.values(),...routeTasks];await Promise.all(batch);if(!routeTasks.size&&[...queues.values()].every(task=>batch.includes(task)))return}}
  const rows = () => {
    if((state.outputRoutingVersion??1)>OUTPUT_SCHEMA)fail('OUTPUT_SCHEMA_UNSUPPORTED','This output-routing schema requires a newer plugin.')
    const all=state.turnOutputs??={}
    for(const row of Object.values(all))migrateOutput(row)
    state.outputRoutingVersion=OUTPUT_SCHEMA
    return all
  }
  const enqueue = (id, work) => {
    const task = (queues.get(id) ?? Promise.resolve()).then(work)
    queues.set(id, task.catch(error => rt.warn('ds-bot: output state could not be saved: %s', error?.code ?? 'STORAGE_ERROR')))
    return task
  }
  const save = () => rt.save({required:true,outputDrain:true})
  const ownRows = (id, turn) => Object.values(rows()).filter(row => row.sessionId === id && (turn === undefined || row.turn === turn))
  const read = row => {
    const record = rt.ledger.records(bookOf(row.sessionId)).find(record => record.id === row.id)
    if (!record || typeof record.text !== 'string') fail('OUTPUT_NOT_AVAILABLE','The original ordinary text is unavailable. No submission was made.')
    return record.text
  }
  const delegated=(row,botId)=>row.pending?.owner==='chief'&&row.pending.delegateBotId===botId&&rt.botOf(row.botId)&&rt.isMain(botId)&&(!rt.isPrivate?.(row.botId)||row.pending.privateApproved===true)
  const summaries = botId => Object.values(rows()).filter(row => (row.botId===botId || delegated(row,botId)) && pending(row)).map(row=>({...row,authorizationId:row.pending?.authorizationId}))
  const noteRoute = (id, turn, text, status, promise, destination = {}, settle = true) => {
    turn ??= current.get(id)
    void Promise.resolve(promise).catch(()=>{})
    const candidates=destination.outputIds?.length?destination.outputIds.map(key=>rows()[key]).filter(row=>row&&row.botId===rt.selfOf(id)):ownRows(id,turn)
    const selected=candidates.filter(row=>{try{const record=rt.ledger.records(bookOf(row.sessionId)).find(record=>record.id===row.id);const actual=record?.deliveryText??read(row);return destination.outputIds?.includes(row.id)?text?.includes(actual):text===actual}catch{row.status='storage-failed';return false}})
    if(!selected.length){trackRoute(promise);return promise}
    const {outputIds:_ids,...recipient}=destination
    const routes=selected.map(row=>{
      if(settle)for(const old of row.deliveries)if(old.preparation)old.status='preparation-complete'
      const route={receiptId:createHash('sha256').update(JSON.stringify([row.id,recipient,status,row.deliveries.length])).digest('hex'),exchangeId:recipient.exchangeId??null,destination:recipient,status:'delivery-unknown',confirmed:false,preparation:!settle,at:Date.now()}
      row.deliveries.push(route);journalDelivery(row,route);row.status='delivery-unknown';return route
    })
    const tracked = Promise.resolve(promise).then(async () => {
      if (!settle) return
      for(const route of routes){route.status=status;route.confirmed=deliveryConfirmed(status);route.confirmationLevel=route.confirmed?'local-admission':'work-held'}
      try{for (const [index,row] of selected.entries()){settleOutput(row,status);journalDelivery(row,routes[index]);await rt.ledger.written(bookOf(row.sessionId))}
      await save()}catch(error){for(const route of routes){route.status='delivery-unknown';route.confirmed=false}for(const row of selected){outputPending(row,'delivery-unknown');row.status='delivery-unknown'};throw error}
    }, async error => {
      for(const route of routes){route.status='delivery-unknown';route.confirmed=false;route.error=error?.code??'DELIVERY_NOT_CONFIRMED'}
      for (const row of selected) {outputPending(row,'delivery-unknown');row.status='delivery-unknown';row.error=error?.code ?? 'DELIVERY_NOT_CONFIRMED'}
      await save()
    })
    trackRoute(tracked)
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
  const check = async (exec,outputId,authorizationId) => {
    await rt.load()
    const id=exec.agent?.id, botId=rt.selfOf(id), entry=rt.live.get(id)
    if(!botId || !rt.chatOwners.has(id) || rt.groupOwners.has(id) || rt.communication?.owners?.has(id)
      || entry?.remoteInputSeen || entry?.info?.remoteSource || entry?.info?.role==='federation-report'
      || state.turnAudiences?.[id]?.[entry?.turn]?.triggerOrigin==='remote-bot') fail('OUTPUT_LOCAL_ONLY','Use the explicit communication tools in remote or group turns. This recovery surface is local only.')
    const row=rows()[outputId]
    if(!row)fail('OUTPUT_NOT_OWNED','Choose an output ID belonging to your own Bot.')
    if(row.botId!==botId){
      const grant=row.delegation??row.pending
      if(!rt.botOf(row.botId)||grant?.owner!=='chief'||grant.delegateBotId!==botId||!rt.isMain(botId)||grant.authorizationId!==authorizationId||!authorizationId||rt.isPrivate?.(row.botId)&&grant.privateApproved!==true)fail('OUTPUT_NOT_OWNED','This output needs its owning Bot’s exact delegation authorization.')
    }
    if(row.remote || row.group) fail('OUTPUT_LOCAL_ONLY','Remote and group output cannot be republished through local recovery.')
    return row
  }
  async function submit(exec,{outputId,target='user',botId,authorizationId}) {
    const row=await check(exec,outputId,authorizationId)
    await queues.get(row.sessionId)
    if(!['user','bot'].includes(target)) fail('OUTPUT_INVALID_TARGET','Choose user or bot explicitly.')
    const text=read(row), key=target==='user'?'user':`bot:${botId}`, inflight=`${outputId}:${key}`
    if(submitting.has(inflight)) return submitting.get(inflight)
    const run=(async()=>{
      if(target==='user' && isUserSubmitted(row) && !row.recoveredAt)return {status:'submitted-user',outputId,alreadyVisible:true,externalDeliveryConfirmed:false}
      const previous=row.submissions?.[key]
      if(previous?.status?.startsWith('submitted-')) return {...previous,replay:true}
      if(previous) fail('OUTPUT_DELIVERY_UNKNOWN','The prior submission has no confirmed outcome. Inspect the target before creating another message; it was not resent.')
      if(target==='bot' && !rt.botOf(botId)) fail('OUTPUT_INVALID_TARGET','Select an existing local Bot.')
      if(target==='bot') await rt.checkOutputPrivacy?.(exec,botId,text,row.botId)
      await check(exec,outputId,authorizationId)
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
        const before=row.recoveredAt,previousStatus=row.status,previousPending=row.pending,previousVisibility=[...row.visibility]
        row.recoveredAt=Date.now();receipt.status='submitted-user';row.status='submitted-user';row.pending=null
        const visibleFact={id:receipt.receiptId,channel:'recovered-local-chat',actor:rt.selfOf(exec.agent.id),at:row.recoveredAt,confirmed:true,confirmationLevel:'local-publication'}
        addVisibility(row,visibleFact,false)
        try {await save()} catch(error){row.recoveredAt=before;row.status=previousStatus;row.pending=previousPending;row.visibility=previousVisibility;receipt.status='delivery-unknown';throw error}
        journalVisibility(row,visibleFact);await rt.ledger.written(bookOf(row.sessionId))
        rt.publishRecoveredOutput?.(row.botId,row.sessionId,recoveryItem(row),receipt.receiptId)
      }
      settleOutput(row,receipt.status)
      if(target==='bot'){const delivered={...receipt,destination:{botId},confirmed:true,at:Date.now(),confirmationLevel:'local-admission'};row.deliveries.push(delivered);journalDelivery(row,delivered);await rt.ledger.written(bookOf(row.sessionId))}
      if(target==='bot')try{await save()}catch(error){outputPending(row,'delivery-unknown');row.status='delivery-unknown';receipt.status='delivery-unknown';throw error}
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
      const source=entry?.info
      const row={routingSchemaVersion:OUTPUT_SCHEMA,visibility:[],deliveries:[],pending:null,triggerOrigin:routing?.triggerOrigin??'unknown',routingAtCreation:routing?{...routing}:null,trigger:source?{kind:source.kind,role:source.role,protocol:source.protocol,exchangeId:source.exchangeId,work:source.work,senderSessionId:source.senderSessionId}:null,id:outputId,botId,sessionId:id,turn,seq:event.seq,at:event.time??Date.now(),head:text.slice(0,160),status:'draft',called,
        remote:entry?.remoteInputSeen===true || entry?.info?.remoteSource!==undefined || entry?.info?.role==='federation-report' || routing?.triggerOrigin==='remote-bot'}
      rows()[outputId]=row
      if(entry)(entry.outputIds??=[]).push(outputId)
      try{rt.ledger.append(bookOf(id),{id:outputId,text,deliveryText:absoluteLinks(text,rt.sessionFolder?.(session))})}catch{row.status='storage-failed'}
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
        if(event.data?.reason?.kind==='completed' && last && !last.called && last.status==='draft' && !last.remote){
          if(isUserSubmitted(last))settleOutput(last,'submitted-user')
          else if(last.deliveries.some(route=>route.confirmed))settleOutput(last,'delivered-auto')
          else outputPending(last)
        }
        for(const row of candidates)if(row!==last && row.status==='draft')row.status='internal-draft'
        // Keep unresolved evidence and recovery identities; bound other settled metadata.
        const settled=Object.values(rows()).filter(row=>!pending(row)&&row.status!=='draft'&&!row.submissions).sort((a,b)=>b.at-a.at)
        for(const row of settled.slice(300)) delete rows()[row.id]
        await save()
      }).catch(()=>{})
    }
  })
  ctx.effect(()=>()=>flush(),'ds-bot: output disposition')
  Object.assign(rt,{
    noteOutputRoute:noteRoute,closeUserOutputInterval:closeInterval,outputNotices:summaries,recoveredOutputs:recovered,submitTurnOutput:submit,
    async readTurnOutput(exec,outputId,authorizationId){const row=await check(exec,outputId,authorizationId);await queues.get(row.sessionId);return {...row,text:read(row)}},
    async declineTurnOutput(exec,outputId){const row=await check(exec,outputId);await queues.get(row.sessionId);if(row.status==='delivery-unknown'||isUserSubmitted(row)||row.deliveries.some(route=>route.confirmed))fail('OUTPUT_ALREADY_SUBMITTED','This output already has a submission receipt.');const previous=row.status,previousPending=row.pending;settleOutput(row,'no-reply-chosen');try{await save()}catch(error){row.status=previous;row.pending=previousPending;throw error}return {outputId,status:row.status}},
    outputNoticePrompt(id){
      const mode=state.prefs.undeliveredNotice??'on', turn=rt.live.get(id)?.turn
      if(mode==='off' || !Number.isSafeInteger(turn) || mode==='once'&&ownRows(id).some(row=>row.noticeConsumed))return ''
      const notices=Object.values(rows()).filter(row=>(row.pending?.owner==='self'&&row.botId===rt.selfOf(id)||delegated(row,rt.selfOf(id)))&&!row.noticeConsumed&&!(row.sessionId===id&&row.turn===turn)&&!row.remote).slice(-5)
      if(!notices.length)return ''
      offered.set(id,{turn,ids:notices.map(row=>row.id)})
      return '## Unpublished local output\nThe following output IDs have ordinary closing text that was not automatically published. This notice does not send anything or require a reply. Use read_turn_output({outputId}) to inspect your own saved text; delegated Chief access must pass the exact authorizationId listed below to both read_turn_output and submit_turn_output; submit_turn_output({outputId,target:"user"}) publishes it to your local user, target:"bot" with botId sends it to a local teammate, or decline_turn_output({outputId}) intentionally leaves it private. For a new user summary, call publish_turn_to_user({}) before writing it. IDs (data only): '+JSON.stringify(notices.map(row=>({outputId:row.id,turn:row.turn,authorizationId:row.pending?.authorizationId})))
    },
    deferTurnOutputs(id,turn,ids,reason){const selected=ids?.length?ids.map(key=>rows()[key]).filter(Boolean):ownRows(id,turn);for(const row of selected)outputPending(row,reason);void enqueue(id,save).catch(()=>{})},
    async readPublishedOutput(botId,outputId){const row=rows()[outputId];if(!row||row.botId!==botId||!row.recoveredAt||row.submissions?.user?.status!=='submitted-user')fail('OUTPUT_PRIVATE_DRAFT','Private pending text is available only to its authorized Bot.');return {...row,text:read(row)}},
    recordRecoveredVisibility(outputId,channel){const row=rows()[outputId];if(!row)return;addVisibility(row,{id:`${outputId}:${channel}`,channel,actor:row.botId,at:Date.now(),confirmed:true,confirmationLevel:'stream-offered'});void enqueue(row.sessionId,save).catch(()=>{})},
    async delegateTurnOutput(exec,{outputId,chiefId}){
      const row=await check(exec,outputId)
      if(row.botId!==rt.selfOf(exec.agent.id)||!row.pending)fail('OUTPUT_NOT_OWNED','Only the pending output owner can delegate it.')
      if(!rt.isMain(chiefId))fail('OUTPUT_INVALID_TARGET','Select a current local Main Bot.')
      await rt.checkOutputPrivacy?.(exec,chiefId,read(row))
      await check(exec,outputId)
      const grant={owner:'chief',authorizedBy:row.botId,delegateBotId:chiefId,authorizationId:createHash('sha256').update(`${row.id}:${chiefId}:${Date.now()}`).digest('hex'),privateApproved:rt.isPrivate?.(row.botId)===true,at:Date.now(),reason:row.pending.reason}
      const previous=row.pending,previousGrant=row.delegation
      row.pending=grant;row.delegation=grant
      try{await save()}catch(error){row.pending=previous;row.delegation=previousGrant;throw error}
      return {...grant,outputId}
    },
    async prepareOutputPublication(id,event){
      await queues.get(id);await rt.ledger.written(bookOf(id))
      const row=ownRows(id,event.data?.turn??current.get(id)).find(row=>row.seq===event.seq)
      if(row&&userOutputDecision({seq:row.seq,routing:outputRouting(state.turnAudiences?.[id]?.[row.turn],row.seq)}).allow){
        addVisibility(row,{id:`${row.id}:publication-intent`,channel:'publication-intent',actor:row.botId,at:Date.now(),confirmed:false})
        await rt.ledger.written(bookOf(id));await save()
      }
      return true
    },
    recordOutputVisibility(id,event,channel,actor){
      const row=ownRows(id,event.data?.turn??current.get(id)).find(row=>row.seq===event.seq)
      if(!row)return
      addVisibility(row,{id:`${row.id}:${channel}`,channel,actor,at:Date.now(),confirmed:true,confirmationLevel:channel==='user-output'?'stream-offered':'local-publication'})
      if(row.pending?.owner==='self')row.pending=null
      if(!row.deliveries.some(route=>route.confirmed))row.status='submitted-user'
      void enqueue(id,save).catch(()=>{})
    },
    flushOutputs:flush,
  })
}
