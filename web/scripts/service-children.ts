import type { ChildProcess } from 'node:child_process'

type ChildState = { child: ChildProcess; done: Promise<void>; stopSent: boolean; sigtermExitCodes: readonly number[] }

// The supervisor owns process completion, not just its listening sockets.
// Startup has its own barrier so a cancelled constructor cannot outlive stop.
export class ServiceChildren {
  private controller = new AbortController()
  private children: ChildState[] = []
  private startup = Promise.withResolvers<void>()
  private shutdown = Promise.withResolvers<number>()
  private closing = false
  private exitCode = 0
  private report: (name: string, event: string) => void
  readonly closed = this.shutdown.promise

  constructor(report: (name: string, event: string) => void = () => {}) { this.report = report }
  get signal() { return this.controller.signal }
  get stopping() { return this.closing }
  finishStartup() { this.startup.resolve() }

  spawn(name: string, create: () => ChildProcess, { sigtermExitCodes = [] }: { sigtermExitCodes?: readonly number[] } = {}) {
    this.signal.throwIfAborted()
    const child = create(), completed = Promise.withResolvers<void>()
    const state = { child, done: completed.promise, stopSent: false, sigtermExitCodes }
    this.children.push(state)
    child.on('error', () => {
      this.report(name, 'failed to start or stop')
      void this.stop(1)
    })
    child.once('exit', (code, signal) => {
      if (!this.closing) {
        this.report(name, 'exited unexpectedly')
        void this.stop(code || 1)
      } else if (code !== 0 && !(state.stopSent && (code === null && signal === 'SIGTERM' || code !== null && state.sigtermExitCodes.includes(code)))) {
        this.exitCode ||= code || 1
      }
    })
    child.once('close', () => completed.resolve())
    return child
  }

  stop(code = 0) {
    this.exitCode ||= code
    if (this.closing) return this.closed
    this.closing = true
    this.controller.abort(Object.assign(new Error('Application services are stopping'), { code: 'SERVICE_STOPPED' }))
    for (const state of this.children) {
      const child = state.child
      if (child.exitCode !== null || child.signalCode !== null) continue
      try { state.stopSent = child.kill('SIGTERM') }
      catch { this.exitCode ||= 1; this.report('Service', 'failed to stop') }
    }
    void Promise.all([this.startup.promise, ...this.children.map(state => state.done)])
      .then(() => this.shutdown.resolve(this.exitCode))
    return this.closed
  }
}

// Only the isolated Vite child uses this IPC receipt, after its real listener
// is ready. Losing a child or stopping during construction rejects the wait.
export function waitForVite(child: ChildProcess, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off('message', message)
      child.off('error', failed)
      child.off('close', failed)
      signal.removeEventListener('abort', aborted)
    }
    const finish = (error?: unknown) => { cleanup(); error ? reject(error) : resolve() }
    const message = value => { if (value?.type === 'miaoimg-vite-ready') finish() }
    const failed = () => finish(new Error('Web service stopped before becoming ready'))
    const aborted = () => finish(signal.reason)
    child.on('message', message)
    child.once('error', failed)
    child.once('close', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else if (child.exitCode !== null || child.signalCode !== null) failed()
  })
}
