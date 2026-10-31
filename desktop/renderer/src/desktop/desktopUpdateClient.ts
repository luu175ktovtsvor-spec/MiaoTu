export type DesktopUpdateSnapshot = {
  canCheck: boolean
  canInstall: boolean
  currentVersion: string
  state: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'failed' | 'dev'
  version: string | null
  percent: number | null
}
export type DesktopUpdateBridge = {
  updateStatus(): Promise<DesktopUpdateSnapshot>
  checkForUpdates(): Promise<DesktopUpdateSnapshot>
  downloadUpdate(): Promise<DesktopUpdateSnapshot>
  quitAndInstall(): Promise<void>
  openUpdatePage(): Promise<void>
  onUpdateStatus(callback: (snapshot: DesktopUpdateSnapshot) => void): () => void
}
export type DesktopUpdatePhase = 'idle' | 'getting' | 'downloading' | 'installing'
const idle = { phase: 'idle' as DesktopUpdatePhase, busy: false }
let action = idle
const listeners = new Set<() => void>()
export const desktopUpdateAction = () => action
export const subscribeDesktopUpdateAction = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function setDesktopUpdatePhase(phase: DesktopUpdatePhase) {
  action = phase === 'idle' ? idle : { phase, busy: true }
  for (const listener of listeners) listener()
}
export function desktopUpdateBridge(): DesktopUpdateBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = window.miaoDesktop as unknown as DesktopUpdateBridge | undefined
  return bridge && ['updateStatus', 'checkForUpdates', 'downloadUpdate', 'quitAndInstall', 'openUpdatePage', 'onUpdateStatus'].every(key => typeof bridge[key] === 'function') ? bridge : null
}
function aborted(signal: AbortSignal) { if (signal.aborted) throw new DOMException('Update observer stopped', 'AbortError') }
function waitForStatus(bridge: DesktopUpdateBridge, done: (snapshot: DesktopUpdateSnapshot) => boolean, signal: AbortSignal, timeout: number) {
  return new Promise<DesktopUpdateSnapshot>((resolve, reject) => {
    let settled = false
    let unsubscribe = () => {}
    let polling = false
    const finish = (error?: unknown, snapshot?: DesktopUpdateSnapshot) => {
      if (settled) return
      settled = true; clearTimeout(timer); clearInterval(poll); unsubscribe(); signal.removeEventListener('abort', cancel)
      error ? reject(error) : resolve(snapshot!)
    }
    const inspect = (snapshot: DesktopUpdateSnapshot) => { if (settled) return; if (snapshot.state === 'failed') finish(new Error('Update failed')); else if (done(snapshot)) finish(undefined, snapshot) }
    const cancel = () => finish(new DOMException('Update observer stopped', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Update timed out')), timeout)
    const poll = setInterval(async () => { if (polling || settled) return; polling = true; try { inspect(await bridge.updateStatus()) } catch (error) { finish(error) } finally { polling = false } }, 1000)
    unsubscribe = bridge.onUpdateStatus(inspect)
    if (settled) { unsubscribe(); return }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    else void bridge.updateStatus().then(inspect, finish)
  })
}
/** A single explicit user action: obtain the latest release, download/verify, then use the native save-and-restart path. */
export async function performDesktopUpdate(bridge: DesktopUpdateBridge, phase: (value: DesktopUpdatePhase) => void, signal: AbortSignal): Promise<'latest' | 'restarting' | 'external' | 'unavailable'> {
  aborted(signal)
  phase('getting')
  let snapshot = await bridge.updateStatus()
  aborted(signal)
  if (!snapshot.canCheck || snapshot.state === 'dev') return 'unavailable'
  if (snapshot.state === 'checking') snapshot = await waitForStatus(bridge, value => value.state !== 'checking', signal, 60000)
  else if (!['available', 'downloading', 'ready'].includes(snapshot.state)) snapshot = await bridge.checkForUpdates()
  aborted(signal)
  if (snapshot.state === 'failed') throw new Error('Update failed')
  if (snapshot.state === 'latest' || snapshot.state === 'idle') return 'latest'
  if (!snapshot.version || !['available', 'downloading', 'ready'].includes(snapshot.state)) throw new Error('Update receipt incomplete')
  const version = snapshot.version
  if (!snapshot.canInstall) { await bridge.openUpdatePage(); return 'external' }
  if (snapshot.state === 'available') { phase('downloading'); snapshot = await bridge.downloadUpdate() }
  if (snapshot.state === 'downloading') { phase('downloading'); snapshot = await waitForStatus(bridge, value => value.state !== 'downloading', signal, 15 * 60000) }
  aborted(signal)
  if (snapshot.state !== 'ready' || snapshot.version !== version || !snapshot.canInstall) throw new Error('Verified update not ready')
  const current = await bridge.updateStatus()
  aborted(signal)
  if (current.state !== 'ready' || current.version !== version || !current.canInstall) throw new Error('Update changed before installation')
  phase('installing')
  await bridge.quitAndInstall()
  return 'restarting'
}
