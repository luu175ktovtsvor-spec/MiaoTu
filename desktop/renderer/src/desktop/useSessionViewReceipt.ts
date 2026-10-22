import { useLayoutEffect } from 'react'

// A status response is only a receipt after React commits the matching view.
// The preload and main process both require the current transition identifier.
export function useSessionViewReceipt(id?: string) {
  useLayoutEffect(() => {
    if (id) void window.miaoDesktop?.completeSessionChange?.(id).catch(() => {})
  }, [id])
}
