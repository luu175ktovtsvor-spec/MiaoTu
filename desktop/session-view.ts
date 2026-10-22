import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'

// Saving precedes the identity change. Keep native input disabled until React
// has committed the corresponding account view, so the retiring editor cannot
// accept another keystroke between the save receipt and its unmount.
export function createSessionView(contents: WebContents) {
  let pending: { id: string; resolve(): void; promise: Promise<void> } | undefined
  const finish = () => {
    const current = pending
    pending = undefined
    current?.resolve()
  }
  const navigated = (_event: unknown, _url: string, _code: number, _status: string, isMainFrame: boolean) => {
    if (isMainFrame) finish()
  }
  // Starting a navigation can still fail and leave the retiring editor alive.
  // Only a committed replacement document can release its identity barrier.
  contents.on('did-frame-navigate', navigated)
  contents.on('render-process-gone', finish)
  contents.on('destroyed', finish)
  return {
    wait() {
      if (pending) return pending.promise
      if (contents.isDestroyed() || contents.isCrashed()) return Promise.resolve()
      let resolve!: () => void
      const promise = new Promise<void>(done => { resolve = done })
      pending = { id: randomUUID(), resolve, promise }
      try { contents.send('desktop:session-restored', pending.id) }
      catch { finish() }
      return promise
    },
    complete(id: unknown) {
      if (!pending || id !== pending.id) return false
      finish()
      return true
    },
    dispose() {
      finish()
      contents.off('did-frame-navigate', navigated)
      contents.off('render-process-gone', finish)
      contents.off('destroyed', finish)
    },
  }
}
