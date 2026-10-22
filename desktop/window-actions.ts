import type { BrowserWindow } from 'electron'
import type { createSaveBarrier } from './save-barrier.ts'

type Options = {
  window: BrowserWindow;
  save: ReturnType<typeof createSaveBarrier>;
  stop(): Promise<void>;
  quit(): void;
  onSaveError(error: unknown): void;
  onReloadError(error: unknown): void;
  onStopError(error: unknown): void;
}

// Own the native window transition, keeping its document and local service alive
// until the existing editor save handlers finish. Reload and quit share saves;
// a quit requested during reload takes precedence over starting another page.
export function createWindowActions(options: Options) {
  const { window, save } = options
  let quitting = false, quitRequested = false
  let quitRequest: Promise<void> | undefined, reloadRequest: Promise<void> | undefined
  let sessionRequest: Promise<void> | undefined
  let sessionRevision = 0
  let activeSession: { phase: 'saving' | 'view' } | undefined
  let recoveringView = false
  let inputDisabled = false
  const alive = () => !window.isDestroyed()
  // Overlapping transitions own one native disable. Repeating setEnabled(false)
  // before its matching enable can leave the macOS window disabled after reload.
  const disable = () => { if (alive() && !inputDisabled) { window.setEnabled(false); inputDisabled = true } }
  const enable = () => {
    if (alive() && inputDisabled && !quitRequested && !quitting && !reloadRequest && !sessionRequest) {
      window.setEnabled(true); inputDisabled = false
    }
  }
  const canRetireSessionView = () => inputDisabled && (activeSession?.phase === 'view' || recoveringView)

  function changeSession(commit: () => void, viewReady: () => Promise<void>): Promise<void> {
    const precedingSession = sessionRequest, precedingReload = reloadRequest
    const revision = sessionRevision
    const assertCurrent = () => {
      if (quitRequested || quitting) throw new Error('工作区正在关闭，请重新打开后登录')
      if (revision !== sessionRevision) throw new Error('工作区正在重新加载，这次账号切换未提交，请重试')
    }
    const work = (async () => {
      await precedingSession?.catch(() => {})
      await precedingReload
      assertCurrent()
      disable()
      const transition = { phase: 'saving' as 'saving' | 'view' }
      activeSession = transition
      try {
        try { await save.flush() }
        catch (error) { if (alive()) options.onSaveError(error); throw error }
        assertCurrent()
        commit()
        transition.phase = 'view'
        await viewReady()
      } finally { if (activeSession === transition) activeSession = undefined }
    })().finally(() => { if (sessionRequest === work) sessionRequest = undefined; enable() })
    sessionRequest = work
    return work
  }

  function reloadDocument() {
    return new Promise<void>((resolve, reject) => {
      const contents = window.webContents
      const cleanup = () => {
        contents.off('did-finish-load', loaded)
        contents.off('did-fail-load', failed)
        contents.off('destroyed', interrupted)
        contents.off('render-process-gone', interrupted)
        contents.off('unresponsive', interrupted)
      }
      const loaded = () => { cleanup(); resolve() }
      const interrupted = () => { cleanup(); reject(new Error('工作区重新加载未完成')) }
      const failed = (_event: unknown, _code: number, _description: string, _url: string, mainFrame: boolean) => { if (mainFrame) interrupted() }
      contents.once('did-finish-load', loaded)
      contents.on('did-fail-load', failed)
      contents.once('destroyed', interrupted)
      contents.once('render-process-gone', interrupted)
      contents.once('unresponsive', interrupted)
      try { contents.reload() } catch (error) { cleanup(); reject(error) }
    })
  }

  function reload(): Promise<void> {
    if (quitRequested || quitting || !alive()) return Promise.resolve()
    if (reloadRequest) return reloadRequest
    const precedingSession = sessionRequest
    let retireView = canRetireSessionView()
    sessionRevision++
    if (retireView) recoveringView = true
    // Register before reload() can synchronously publish native navigation.
    const work = Promise.resolve().then(async () => {
      retireView ||= canRetireSessionView()
      if (retireView) {
        recoveringView = true
        if (quitRequested || quitting || !alive()) return
        // The old editor already saved and input stayed disabled through commit.
        // Start real navigation before joining its otherwise unreachable ACK.
        try { await Promise.all([reloadDocument(), precedingSession?.catch(() => {})]) }
        catch (error) { if (!quitRequested && alive()) options.onReloadError(error) }
        return
      }
      await precedingSession?.catch(() => {})
      if (quitRequested || quitting || !alive()) return
      disable()
      try { await save.flush() }
      catch (error) { if (!quitRequested && alive()) options.onSaveError(error); return }
      if (quitRequested || quitting || !alive()) return
      try { await reloadDocument() }
      catch (error) { if (!quitRequested && alive()) options.onReloadError(error) }
    }).finally(() => {
      if (retireView) recoveringView = false
      if (reloadRequest === work) reloadRequest = undefined
      enable()
    })
    reloadRequest = work
    return work
  }

  function quit(action = options.quit): Promise<void> {
    if (quitRequest) return quitRequest
    if (quitting) return Promise.resolve()
    const retireView = canRetireSessionView()
    quitRequested = true
    sessionRevision++
    const precedingSession = sessionRequest
    // Destruction can synchronously re-enter quit via window-all-closed.
    const work = Promise.resolve().then(async () => {
      if ((retireView || canRetireSessionView()) && alive()) {
        // Only the saved, committed transition may retire without a second JS
        // receipt. Real destruction releases its view wait and any reload.
        window.destroy()
      }
      // A reload already committing must finish before collecting its new page;
      // a reload still saving sees quitRequested and does not navigate.
      await reloadRequest
      await precedingSession?.catch(() => {})
      disable()
      try { await save.flush() }
      catch (error) {
        if (alive()) {
          quitRequested = false
          enable()
          window.focus()
          options.onSaveError(error)
          return
        }
        // Destruction already removed the JS draft; still close the service.
      }
      try { await options.stop() } catch (error) { options.onStopError(error) }
      quitting = true
      save.dispose()
      try { action() } catch { options.quit() }
    }).finally(() => { if (quitRequest === work) quitRequest = undefined })
    quitRequest = work
    return work
  }
  return { quit, reload, changeSession, get quitting() { return quitting } }
}
