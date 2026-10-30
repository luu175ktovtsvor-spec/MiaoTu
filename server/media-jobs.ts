import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { execFile } from 'node:child_process'

type Job<T> = { controller: AbortController; signal: AbortSignal; promise: Promise<T>; readers: Map<symbol, () => void | Promise<void>> }
export const waitForMedia = <T>(promise: Promise<T>, signal?: AbortSignal) => awaitWithContext(promise, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT)

// execFile can report an AbortError before close. Media slots and temporary
// files remain owned until the process and its stdio have actually closed.
export function execMedia(command: string, args: string[], options: { signal?: AbortSignal; timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    let failure: Error | undefined, output = ''
    const child = execFile(command, args, { ...options, encoding: 'utf8', killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => {
      if (error) failure ||= error
      output = stdout
    })
    child.on('error', error => { failure ||= error })
    child.on('close', code => {
      if (options.signal?.aborted) reject(options.signal.reason)
      else if (failure || code !== 0) reject(failure || new Error('媒体处理未完成'))
      else resolve(output)
    })
  })
}

// A reader owns its wait; the last reader owns cancellation of the decoder.
// Retain the job until the operation actually releases its process and files.
export class MediaJobs<T> {
  private lifetime = new AbortController()
  private jobs = new Map<string, Job<T>>()
  private waiting: Array<() => void> = []
  private active = 0
  private concurrency: number
  private timeoutMs?: number
  constructor(concurrency: number, { timeoutMs }: { timeoutMs?: number } = {}) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('媒体处理并行数无效')
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error('媒体处理期限无效')
    this.concurrency = concurrency
    this.timeoutMs = timeoutMs
  }
  get signal() { return this.lifetime.signal }
  get size() { return this.jobs.size }
  has(key: string) { return this.jobs.has(key) }
  private enter(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(start)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason)
      }
      const start = () => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) { abort(); return }
        this.active++
        let released = false
        resolve(() => {
          if (released) return
          released = true; this.active--
          while (this.active < this.concurrency && this.waiting.length) this.waiting.shift()!()
        })
      }
      signal.addEventListener('abort', abort, { once: true })
      if (this.active < this.concurrency) start()
      else this.waiting.push(start)
    })
  }
  async run(key: string, operation: (signal: AbortSignal, beforeCommit: () => Promise<void>) => Promise<T>, signal?: AbortSignal, validate: () => void | Promise<void> = () => {}): Promise<T> {
    this.signal.throwIfAborted(); signal?.throwIfAborted()
    let entry = this.jobs.get(key)
    while (entry?.signal.aborted) {
      await waitForMedia(entry.promise.catch(() => {}), signal)
      this.signal.throwIfAborted(); signal?.throwIfAborted()
      entry = this.jobs.get(key)
    }
    if (!entry) {
      const controller = new AbortController()
      const taskSignal = AbortSignal.any([this.signal, controller.signal, ...(this.timeoutMs ? [AbortSignal.timeout(this.timeoutMs)] : [])])
      const readers = new Map<symbol, () => void | Promise<void>>()
      const beforeCommit = async () => {
        taskSignal.throwIfAborted()
        let failure: unknown = new DOMException('媒体已没有读取者', 'AbortError')
        // Aliases may share the same immutable original/cache. One deleted
        // alias must not veto publication for another still-valid consumer.
        for (const check of readers.values()) {
          try { await check(); taskSignal.throwIfAborted(); return } catch (error) { failure = error }
        }
        throw failure
      }
      const promise = Promise.resolve().then(async () => {
        const release = await this.enter(taskSignal)
        try { taskSignal.throwIfAborted(); return await operation(taskSignal, beforeCommit) }
        finally { release() }
      }).finally(() => { if (this.jobs.get(key)?.controller === controller) this.jobs.delete(key) })
      entry = { controller, signal: taskSignal, promise, readers }
      this.jobs.set(key, entry)
    }
    const current = entry
    const reader = Symbol()
    current.readers.set(reader, async () => { signal?.throwIfAborted(); await validate(); signal?.throwIfAborted() })
    try {
      const value = await waitForMedia(current.promise, signal)
      signal?.throwIfAborted(); await validate(); signal?.throwIfAborted()
      return value
    } finally {
      current.readers.delete(reader)
      if (!current.readers.size && this.jobs.get(key) === current) current.controller.abort()
    }
  }
  async stop() {
    this.lifetime.abort()
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise))
  }
}
