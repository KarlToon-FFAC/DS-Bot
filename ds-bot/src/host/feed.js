import {explicitUserStream} from '../shared/turn-audience.js'
// The live feed: a Server-Sent Events stream of what changes, for a window that draws
// the team itself (the desktop app) instead of polling.
//   revision  the team was saved: ask for `state` again
//   live      work changed without a new revision: ask for `state` again
//   message   a new entry of a Bot's own chat, as the `chat` endpoint returns it
//   stream    the reply a Bot is writing: a start, its text as it comes, an end
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
  const send = (controller, chunk) => {
    if ((controller.desiredSize ?? 0) < -MAX_QUEUED) {
      leave(controller)
      return
    }
    try { controller.enqueue(chunk) } catch { clients.delete(controller); userClients.delete(controller) }
  }
  const publish = (event, data) => {
    const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const controller of clients) send(controller, chunk)
  }

  rt.stateSaved = () => {
    if (clients.size > 0) publish('revision', { revision: state.revision })
  }

  let liveTimer
  const live = () => {
    if (clients.size === 0 || liveTimer !== undefined) return
    liveTimer = setTimeout(() => {
      liveTimer = undefined
      publish('live', {})
    }, LIVE_DELAY_MS)
  }
  ctx.on('agent/status', ({ agent }) => {
    if (rt.selfOf(agent.id) !== undefined) live()
  })

  ctx.on('session/event', (session, event) => {
    if (clients.size === 0 && userClients.size === 0) return
    const botId = rt.chatOwners.get(session.id)
    if (botId === undefined) return
    for (const [index, item] of rt.displayItems(session.id, [event]).entries()) {
      publish('message', { botId, sessionId: session.id, item })
      if (item.kind === 'bot' && item.routing?.audience === 'user' && Number.isSafeInteger(event.seq)) {
        const chunk = encoder.encode(`event: user-output\ndata: ${JSON.stringify({botId,sessionId:session.id,outputId:`${session.id}:${event.seq}:${index}`,item})}\n\n`)
        for (const [controller, target] of userClients) if (target === botId) send(controller, chunk)
      }
    }
    if (event.type === 'tool/call') live()
  })

  // Attempts being streamed, by id. A turn that answers another Bot is hidden from the
  // chat (turns.js marks it before the model is called), so its text is not streamed.
  const writing = new Map()
  const canStream = (id, turn) => {
    const routing = state.turnAudiences?.[id]?.[turn]
    return routing?.explicit === true ? !rt.pendingUserPublications?.has(`${id}:${turn}`) && explicitUserStream(routing)
      : !(state.exchangeTurns[id] ?? []).includes(turn) && routing?.audience !== 'internal'
  }
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      const botId = rt.chatOwners.get(agent.id)
      if (clients.size === 0 || botId === undefined || !canStream(agent.id, frame.turn)) return
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

  const leave = (controller) => {
    clients.delete(controller); userClients.delete(controller)
    if (clients.size === 0) writing.clear()
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
          send(own, encoder.encode(`event: hello\ndata: ${JSON.stringify({ revision: state.revision })}\n\n`))
        },
        cancel() { leave(controller) },
      })
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
      clearInterval(keepalive)
      clearTimeout(liveTimer)
      for (const controller of [...clients,...userClients.keys()]) leave(controller)
    }
  }, 'ds-bot: live feed')
}
