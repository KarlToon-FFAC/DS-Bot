import { useEffect, useRef } from 'react'

// Hints only invalidate a view. Every update still comes from an authorized read.
export function liveRefresh(work, { onError = () => {}, intervalMs = 5000, minRefreshMs = Math.min(500, intervalMs), document: doc = globalThis.document, window: win = globalThis.window, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let stopped = false, running = false, dirty = false, timer, dueAt = Infinity, lastStarted = 0, failures = 0
  const visible = () => doc?.visibilityState !== 'hidden'
  const clear = () => { clearTimer(timer); timer = undefined; dueAt = Infinity }
  const schedule = (delay, earlierOnly = false) => {
    delay = Math.max(delay, minRefreshMs - (Date.now() - lastStarted))
    const due = Date.now() + delay
    if (earlierOnly && timer !== undefined && dueAt <= due) return
    clear()
    if (!stopped && visible()) {
      dueAt = due
      timer = setTimer(() => { timer = undefined; dueAt = Infinity; void run() }, delay)
    }
  }
  const run = async () => {
    if (stopped || !visible()) return
    if (running) { dirty = true; return }
    running = true; dirty = false; lastStarted = Date.now()
    try { await work(); failures = 0 }
    catch (error) { failures += 1; if (!stopped) onError(error) }
    finally {
      running = false
      schedule(dirty && !failures ? 100 : Math.min(30000, intervalMs * 2 ** Math.min(failures, 3)))
    }
  }
  const wake = () => {
    if (stopped) return
    if (!visible()) { clear(); return }
    if (running) dirty = true
    else schedule(failures ? Math.min(30000, intervalMs * 2 ** Math.min(failures, 3)) : 100, true)
  }
  const resume = () => { if (visible()) failures = 0; wake() }
  doc?.addEventListener('visibilitychange', resume)
  win?.addEventListener('online', resume)
  win?.addEventListener('focus', resume)
  void run()
  return { wake, stop() {
    stopped = true; clear()
    doc?.removeEventListener('visibilitychange', resume)
    win?.removeEventListener('online', resume)
    win?.removeEventListener('focus', resume)
  } }
}

export function useLiveRefresh(work, onError, request, revision, intervalMs = 5000) {
  const latest = useRef({ work, onError }), live = useRef(null), previous = useRef(revision)
  latest.current = { work, onError }
  useEffect(() => {
    const controller = liveRefresh(() => latest.current.work(), { intervalMs, onError: error => latest.current.onError(error) })
    live.current = controller
    return () => { controller.stop(); if (live.current === controller) live.current = null }
  }, [request, intervalMs])
  useEffect(() => {
    if (previous.current !== revision) { previous.current = revision; live.current?.wake() }
  }, [revision])
}
