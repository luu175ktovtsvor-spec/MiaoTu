import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'

// Keep the renderer and its local HTTP service alive until its existing save
// handlers have settled. This is distinct from draining already accepted I/O.
export function createSaveBarrier(contents: WebContents) {
  let ready = false, responsive = true
  let pending: { id: string; promise: Promise<void>; resolve(): void; reject(error: Error): void } | undefined
  const notResponsive = () => Object.assign(new Error('工作区页面暂无响应，请等待恢复后再保存。'), { code: 'WORKSPACE_UNRESPONSIVE' })
  const interrupted = () => {
    const request = pending
    pending = undefined
    request?.reject(!responsive ? notResponsive() : new Error('工作区未能完成保存，已取消退出。请恢复页面后重试。'))
  }
  const navigating = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) { ready = false; interrupted() }
  }
  const unavailable = () => { ready = false; interrupted() }
  const unresponsive = () => { responsive = false; interrupted() }
  const recovered = () => { responsive = true }
  contents.on('render-process-gone', unavailable)
  contents.on('destroyed', unavailable)
  contents.on('unresponsive', unresponsive)
  contents.on('responsive', recovered)
  contents.on('did-start-navigation', navigating)
  return {
    ready() { ready = true; responsive = true },
    flush(): Promise<void> {
      if (pending) return pending.promise
      // A page before its preload, or a crashed/destroyed renderer, has no
      // editable JS draft to collect. Accepted writes still drain on shutdown.
      if (!ready || contents.isDestroyed() || contents.isCrashed()) return Promise.resolve()
      if (!responsive) return Promise.reject(notResponsive())
      let resolve!: () => void, reject!: (error: Error) => void
      const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
      pending = { id: randomUUID(), promise, resolve, reject }
      try { contents.send('desktop:save-before-close', pending.id) }
      catch { interrupted() }
      return promise
    },
    complete(id: unknown, ok: unknown, error: unknown) {
      if (!pending || id !== pending.id || typeof ok !== 'boolean') return false
      const request = pending
      pending = undefined
      if (ok) request.resolve()
      else request.reject(new Error(typeof error === 'string' && error ? error : '工作区尚未保存，请重试。'))
      return true
    },
    dispose() {
      interrupted()
      contents.off('render-process-gone', unavailable)
      contents.off('destroyed', unavailable)
      contents.off('unresponsive', unresponsive)
      contents.off('responsive', recovered)
      contents.off('did-start-navigation', navigating)
    },
  }
}
