import {userOutputDecision} from '../shared/user-output-policy.js'
import {explicitUserStream} from '../shared/turn-audience.js'
// The live feed: a Server-Sent Events stream of what changes, for a window that draws
// the team itself (the desktop app) instead of polling.
//   revision  the team was saved: ask for `state` again
//   live      work changed without a new revision: ask for `state` again
//   message   a new entry of a Bot's own chat, as the `chat` endpoint returns it
//   stream    the reply a Bot is writing: a start, its text as it comes, an end
//   notice    something a client that is not looking should hear about (mobile.js)
//   room      a group chat changed: ask for `room-chat` again
// `hello` carries the team's revision and, for the mobile API, its version and the
// latest notice, so a client that reconnects knows what it missed.
import { ROUTE } from './constants.js'

export const FEED_ROUTE = `${ROUTE}/feed`
// A comment line now and then keeps an idle connection open.
const KEEPALIVE_MS = 20_000
// Status changes come in bursts (a turn starts several Sessions); one notice covers them.
const LIVE_DELAY_MS = 150
// A window that stops reading is dropped once this many events wait for it; it
// reconnects and catches up from `hello`.
const MAX_QUEUED = 512

export function install(rt) {
  const { ctx, state } = rt
  const encoder = new TextEncoder()
  /** @type {Set<ReadableStreamDefaultController<Uint8Array>>} */
  const clients = new Set()
  const userClients = new Map()
  let closed=false
  const send = (controller, chunk) => {
    if ((controller.desiredSize ?? 0) < -MAX_QUEUED) {
      leave(controller)
      return
    }
    try { controller.enqueue(chunk) } catch { clients.delete(controller); userClients.delete(controller) }
  }
  const publish = (event, data) => {
    for (const tap of taps) {
      try { tap(event, data) } catch { /* taps are isolated from the feed */ }
    }
    if (clients.size === 0) return
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const controller of clients) send(controller, chunk)
  }

  rt.publishRecoveredOutput=(botId,sessionId,item,outputId)=>{
    if(closed||!userOutputDecision(item).allow)return
    publish('message',{botId,sessionId,item})
    const chunk=encoder.encode(`event: user-output\ndata: ${JSON.stringify({botId,sessionId,outputId,item})}\n\n`)
    for(const [controller,target] of userClients)if(target===botId){rt.recordRecoveredVisibility?.(item.routing.originalOutputId,'recovered-user-output');send(controller,chunk)}
  }

  const feedHello = () => ({ revision: state.revision, ...(rt.noticeCursor ? { api: rt.apiVersion, ...rt.noticeCursor() } : {}) })

  // Non-SSE listeners (the phone link) get every event through a tap; a tap is
  // isolated so a slow or throwing listener never hurts SSE clients.
  const taps = new Set()
  rt.feedTap = (listener) => { taps.add(listener); return () => taps.delete(listener) }
  // Remote subscribers (such as `dsBot/feed`) open at `hello` and then track every live event.
  rt.subscribeFeed = (listener) => {
    const untap = rt.feedTap(listener)
    try { listener('hello', feedHello()) } catch { /* isolate subscriber errors */ }
    return untap
  }
  const listening = () => clients.size > 0 || taps.size > 0
  const offSaved = rt.onSaved(() => {
    if (listening()) publish('revision', { revision: state.revision })
  })
  rt.publishFeed = (event, data) => {
    if (listening()) publish(event, data)
  }

  let liveTimer
  const live = () => {
    if (!listening() || liveTimer !== undefined) return
    liveTimer = setTimeout(() => {
      liveTimer = undefined
      publish('live', {})
    }, LIVE_DELAY_MS)
  }
  ctx.on('agent/status', ({ agent }) => {
    if (rt.selfOf(agent.id) !== undefined) live()
  })

  ctx.on('session/event', (session, event) => {
    if(closed || !listening()&&userClients.size===0&&event.type!=='assistant/message')return
    const botId=rt.chatOwners.get(session.id)
    if(botId===undefined)return
    const emit=()=>{
      if(closed)return
      // Resolve again after storage awaits. A mutable turn label is never a send receipt.
      for(const [index,item] of rt.displayItems(session.id,[event]).entries()){
        const allowed=item.kind==='bot'&&userOutputDecision(item).allow
        if(item.kind==='bot'&&!allowed)continue
        if(allowed)rt.recordOutputVisibility?.(session.id,event,'local-chat',botId)
        publish('message',{botId,sessionId:session.id,item})
        if(allowed&&Number.isSafeInteger(event.seq)){
          const chunk=encoder.encode(`event: user-output\ndata: ${JSON.stringify({botId,sessionId:session.id,outputId:`${session.id}:${event.seq}:${index}`,item})}\n\n`)
          for(const [controller,target] of userClients)if(target===botId){rt.recordOutputVisibility?.(session.id,event,'user-output',botId);send(controller,chunk)}
        }
      }
      if(event.type==='tool/call')live()
    }
    if(event.type==='assistant/message'&&rt.prepareOutputPublication){
      void rt.prepareOutputPublication(session.id,event).then(emit).catch(error=>rt.warn('ds-bot: output publication not prepared: %s',error?.code??'STORAGE_ERROR'))
    }else emit()
  })

  // Attempts being streamed, by id. A turn that answers another Bot is hidden from the
  // chat (turns.js marks it before the model is called), so its text is not streamed.
  const writing = new Map()
  const canStream = (id, turn) => {
    const routing = state.turnAudiences?.[id]?.[turn]
    if(routing?.explicit!==true && routing?.userOutputThroughSeq!==undefined)return false
    return routing?.explicit === true ? !rt.pendingUserPublications?.has(`${id}:${turn}`) && explicitUserStream(routing)
      : !(state.exchangeTurns[id] ?? []).includes(turn) && routing?.audience === 'user' && (routing.triggerOrigin==='user'||routing.userDirectedRequest===true&&routing.triggerOrigin==='local-bot'&&routing.protocol==='request')
  }
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      const botId = rt.chatOwners.get(agent.id)
      if (!listening() || botId === undefined || !canStream(agent.id, frame.turn)) return
      writing.set(frame.attemptId, { target: { botId, sessionId: agent.id }, turn: frame.turn })
      publish('stream', { botId, sessionId: agent.id, attemptId: frame.attemptId, phase: 'start' })
      return
    }
    const writingTurn = writing.get(frame.attemptId), target = writingTurn?.target
    if (target === undefined) return
    if (!canStream(target.sessionId, writingTurn.turn)) {
      writing.delete(frame.attemptId)
      publish('stream', { ...target, attemptId: frame.attemptId, phase: 'end' })
      return
    }
    if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta') publish('stream', { ...target, attemptId: frame.attemptId, text: frame.chunk.text })
    else if (frame.type === 'end') {
      writing.delete(frame.attemptId)
      publish('stream', { ...target, attemptId: frame.attemptId, phase: 'end' })
    }
  })

  // A Request built on a caller's signal only follows it while the Request is reachable;
  // once collected, its abort never fires and the feed stays open. Each open feed keeps
  // its Request until it leaves.
  const requests = new Map()
  const leave = (controller) => {
    clients.delete(controller); userClients.delete(controller)
    requests.delete(controller)
    if (!listening()) writing.clear()
    try { controller.close() } catch { /* already closed or errored */ }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${ROUTE}/user-output`, methods: ['GET'], requestBody: 'buffered',
    fetch: async request => {
      await rt.load(); await rt.refresh()
      const target = new URL(request.url).searchParams.get('botId')
      if (!target || !rt.botOf(target)) return new Response('Unknown Bot', {status:400})
      let controller
      const body = new ReadableStream({
        start(own) { controller = own; userClients.set(own,target); send(own,encoder.encode('event: hello\ndata: {}\n\n')) },
        cancel() { leave(controller) },
      })
      request.signal.addEventListener('abort', () => leave(controller), {once:true})
      return new Response(body, {headers:{'content-type':'text/event-stream', 'cache-control':'no-store'}})
    },
  }), 'ds-bot: user-visible output')
  ctx.effect(() => ctx.connection.fetch.register({
    path: FEED_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let controller
      const body = new ReadableStream({
        start(own) {
          controller = own
          clients.add(own)
          send(own, encoder.encode(`event: hello\ndata: ${JSON.stringify(feedHello())}\n\n`))
        },
        cancel() { leave(controller) },
      })
      requests.set(controller, request)
      request.signal.addEventListener('abort', () => leave(controller), { once: true })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } })
    },
  }), 'ds-bot: live feed route')

  ctx.effect(() => {
    const keepalive = setInterval(() => {
      if (clients.size > 0 || userClients.size > 0) for (const controller of [...clients,...userClients.keys()]) send(controller, encoder.encode(': keepalive\n\n'))
    }, KEEPALIVE_MS)
    keepalive.unref?.()
    return () => {
      closed=true
      clearInterval(keepalive)
      clearTimeout(liveTimer)
      offSaved()
      for (const controller of [...clients,...userClients.keys()]) leave(controller)
    }
  }, 'ds-bot: live feed')
}
