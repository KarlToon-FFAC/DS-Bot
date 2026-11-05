import { isCommunicationContext } from './session-scope.js'

// Only a real journal step, paired with that turn's admitted inputs, proves work began.
export function startedSources(events, step) {
  if (step?.type !== 'step/start' || !Number.isSafeInteger(step.seq) || !Number.isSafeInteger(step.data?.turn)) return []
  const index = events.findIndex(event => event.type === 'step/start' && event.seq === step.seq && event.data?.turn === step.data.turn)
  if (index < 0) return []
  let before = index, after = index + 1
  // Admission next to the marker must stay inside its step and turn boundaries.
  while (before > 0 && !['step/start', 'step/end', 'turn/start', 'turn/end'].includes(events[before - 1].type)) before--
  while (after < events.length && !['step/start', 'step/end', 'turn/start', 'turn/end'].includes(events[after].type)) after++
  let turn
  const sources = []
  for (const [position, event] of events.entries()) {
    if (position >= after) break
    if (event.type === 'turn/start') turn = event.data?.turn
    if (position < before) continue
    if (event.type !== 'user/message' || (event.data?.turn ?? turn) !== step.data.turn) continue
    const source = event.data?.source
    if (['agent-instructions', 'working-directory'].includes(source?.kind) || isCommunicationContext(source)) continue
    sources.push(source)
  }
  return sources
}
