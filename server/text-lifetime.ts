import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'

// The reader and the host own different lifetimes. A billed call can detach
// from its reader only at its single dispatch boundary; host shutdown still
// cancels it and joins its accounting before the database closes.
export class TextOperation {
  readonly signal: AbortSignal
  readonly done: Promise<void>
  private reader = new AbortController()
  private resolveDone: () => void
  private finished = false
  private keepAfterDisconnect = false
  private readerClosed = false
  private started = false
  private released: () => void
  readonly onStop?: () => void

  constructor(service: AbortSignal, released: () => void, onStop?: () => void) {
    this.released = released
    this.onStop = onStop
    this.signal = AbortSignal.any([service, this.reader.signal])
    this.done = new Promise(resolve => { this.resolveDone = resolve })
  }
  get dispatched() { return this.started }
  get connected() { return !this.readerClosed }
  continueAfterDisconnect(value: boolean) { this.keepAfterDisconnect = value }
  disconnect(reason = new DOMException('文本读取连接已断开', 'AbortError')) {
    this.readerClosed = true
    if (!this.started || !this.keepAfterDisconnect) this.reader.abort(reason)
  }
  async dispatch(commit: () => void) {
    this.signal.throwIfAborted()
    if (this.readerClosed) throw new DOMException('文本读取连接已断开', 'AbortError')
    if (this.started) throw Object.assign(new Error('原文本请求已经派发，未重复提交'), { status: 409 })
    await commit()
    this.started = true
  }
  wait<T>(pending: Promise<T>): Promise<T> {
    return awaitWithContext(pending, withAbortSignal(this.signal, BACKGROUND_CONTEXT))
  }
  finish() {
    if (this.finished) return
    this.finished = true
    this.released()
    this.resolveDone()
  }
}

export class TextOperations {
  private service = new AbortController()
  private entries = new Set<TextOperation>()
  private closing: Promise<void> | undefined

  begin(onStop?: () => void) {
    if (this.service.signal.aborted) throw Object.assign(new Error('服务正在关闭，请稍后重试'), { status: 503 })
    const operation = new TextOperation(this.service.signal, () => this.entries.delete(operation), onStop)
    this.entries.add(operation)
    return operation
  }
  stop(): Promise<void> {
    if (this.closing) return this.closing
    const entries = [...this.entries]
    // Cache the join before notifying listeners: stop remains idempotent even
    // if a cancellation callback asks for the same shutdown promise.
    this.closing = Promise.allSettled(entries.map(entry => entry.done)).then(() => undefined)
    this.service.abort(new DOMException('文本服务正在关闭', 'AbortError'))
    for (const entry of entries) {
      try { entry.onStop?.() } catch { /* All other requests must still stop. */ }
    }
    return this.closing
  }
}
