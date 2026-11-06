import { useEffect, useRef } from 'react'

export function useMentionDismiss(input, open, dismiss) {
  const latest = useRef(dismiss)
  latest.current = dismiss
  useEffect(() => {
    if (!open) return undefined
    const outside = event => {
      const composer = input.current?.closest('footer,.bt-comm-thread-composer')
      if (event.target !== input.current && !composer?.querySelector('.bt-comm-completion')?.contains(event.target)) latest.current()
    }
    // Dismiss without consuming the click or moving focus: an unfinished @ is
    // only a suggestion, never a modal interaction or a navigation lock.
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside, true) }
  }, [Boolean(open)])
}
