// -------------------------------------------------------------------------
// Small observable sources for the inject `hooks` compartment.

export function createSource(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) {
      const resolved = typeof next === 'function' ? next(value) : next
      if (resolved === value) return
      value = resolved
      for (const listener of [...listeners]) listener()
    },
  }
}

// Configuration and service state can change while the saved team revision stays fixed.
export function updateLiveRoster(roster, value) {
  const current = roster.getSnapshot()
  if (!current.ready) return
  const changed = {}
  for (const [key, fallback] of Object.entries({ connectors: [], capabilityStatuses: {}, learning: {}, btwCards: {}, sideChats: {}, remoteHubEnabled: false, remoteUnreadCount: 0, remoteHubWithdrawalPending: false, remoteHubWithdrawalError: null, communicationEnabled: false, communicationHubId: null })) {
    if (value[key] !== undefined && JSON.stringify(value[key]) !== JSON.stringify(current[key] ?? fallback)) changed[key] = value[key]
  }
  if (Object.keys(changed).length) roster.set({ ...current, ...changed })
}

export const EMPTY_ROSTER = { revision: -1, mainBotId: null, mainBotIds: [], bots: [], rooms: [], agents: [], exchangeTurns: {}, questions: {}, btwCards: {}, sideChats: {}, learning: {}, secrets: [], capabilities: [], capabilityStatuses: {}, secretRequests: {}, models: [], defaultModel: null, modelsKey: null, prefs: {}, byId: {}, roomsById: {}, agentsById: {}, agentOf: {}, ready: false }
// Any Main Bot holds the Main Bot powers; `mainBotId`, the first one, is the sidebar tile.
export const isMainOf = (roster, id) => id !== undefined && (roster.mainBotIds ?? []).includes(id)

// A Bot's chat is a chain of Sessions ("parts"): the Bot id is its first part's id
// and `sessionId` its current one. Every part id finds the Bot; Session state
// (running, unread, turns) is read from the current part, team state from the Bot id.
export function indexRoster(value) {
  const byId = {}
  for (const bot of value.bots) {
    for (const id of [...(bot.parts ?? []), bot.sessionId ?? bot.id, bot.id]) byId[id] = bot
  }
  const roomsById = {}
  // A group's own Session is a chain of parts like a Bot's chat: `room.id` is its
  // first part's id and `sessionId` its current one; every part id finds the room.
  for (const room of value.rooms) {
    for (const id of [room.id, room.sessionId, ...(room.ownParts ?? [])]) roomsById[id] = room
  }
  // The DSH Agent is not a Bot: it indexes by its own id and by each Session it owns.
  const agentsById = {}
  const agentOf = {}
  for (const agent of value.agents ?? []) {
    agentsById[agent.id] = agent
    for (const sessionId of agent.sessions ?? []) agentOf[sessionId] = agent.id
  }
  return { ...value, agents: value.agents ?? [], byId, roomsById, agentsById, agentOf, ready: true }
}

// Whether a main-view Session id belongs to the team's DSH Agent: the conversation
// group then stays withdrawn while the shell keeps the sidebar. Before the roster
// arrives, the ids cached from the last pull answer.
export function isAgentSession(roster, cache, sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') return false
  if (roster.ready) return roster.agentOf[sessionId] !== undefined
  return cache.has(sessionId)
}

// A request can reuse a call id; question and secret ids belong to separate kinds.
export const heldCardKey = (kind, requestId) => JSON.stringify([kind, requestId])

// Per Session, how many mounted cells draw or hold each card; 0 drops the entry.
export function countCards(state, sessionId, callIds, delta) {
  const own = { ...state[sessionId] }
  for (const callId of callIds) {
    const count = (own[callId] ?? 0) + delta
    if (count > 0) own[callId] = count
    else delete own[callId]
  }
  return { ...state, [sessionId]: own }
}
