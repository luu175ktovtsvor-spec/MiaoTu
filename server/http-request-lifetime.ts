import type { IncomingMessage, ServerResponse } from 'node:http'

const requestSignals = new WeakMap<IncomingMessage, AbortSignal>()

// Service shutdown is independent of the response reader's lifetime. In
// particular, losing a video poll reader must not detach its original handler.
export function incomingRequestSignal(request: IncomingMessage, signal?: AbortSignal): AbortSignal | undefined {
  const service = requestSignals.get(request)
  return signal && service && signal !== service ? AbortSignal.any([service, signal]) : signal || service
}

export class HttpIncomingRequests {
  private entries = new Set<{ request: IncomingMessage; response: ServerResponse; controller: AbortController; done: Promise<void> }>()
  private closing?: Promise<void>
  private unavailable: string
  private retireResponses: boolean
  constructor(unavailable = '服务正在关闭，请稍后重试', retireResponses = false) {
    this.unavailable = unavailable
    this.retireResponses = retireResponses
  }

  begin(request: IncomingMessage, response: ServerResponse) {
    if (this.closing) throw Object.assign(new Error(this.unavailable), { status: 503 })
    const controller = new AbortController(), completed = Promise.withResolvers<void>()
    const signal = incomingRequestSignal(request, controller.signal)!
    requestSignals.set(request, signal)
    const entry = { request, response, controller, done: completed.promise }
    this.entries.add(entry)
    // A reader may not have started yet when shutdown destroys its upload.
    // Own the late error until the real IncomingMessage has ended/closed.
    const drainingError = () => {}
    const drained = () => {
      request.off('error', drainingError)
      request.off('end', drained)
      request.off('close', drained)
    }
    request.on('error', drainingError)
    request.once('end', drained)
    request.once('close', drained)
    if (request.readableEnded) drained()
    let finished = false
    const release = () => {
      response.off('finish', release)
      response.off('close', release)
      if (!request.complete && !request.destroyed) request.destroy()
      this.entries.delete(entry)
      completed.resolve()
    }
    return {
      signal,
      abort: (reason?: any) => controller.abort(reason),
      finish: () => {
        if (finished) return
        finished = true
        // Called only by the handler's finally. A disconnected response alone
        // never removes a handler that is still finalizing files/accounting.
        if (request.complete || request.destroyed || response.writableFinished || response.destroyed) release()
        else {
          response.once('finish', release)
          response.once('close', release)
        }
      },
    }
  }

  stop() {
    if (this.closing) return this.closing
    const entries = [...this.entries]
    this.closing = Promise.allSettled(entries.map(entry => entry.done)).then(() => undefined)
    for (const { request, response, controller } of entries) {
      controller.abort(Object.assign(new Error(this.unavailable), { status: 503 }))
      if (!request.complete && !request.destroyed) request.destroy()
      // The top HTTP host also retires readers whose legacy transports only
      // listen to response.close. Their actual handlers remain in the join.
      if (this.retireResponses && !response.writableEnded && !response.destroyed) response.destroy()
    }
    return this.closing
  }
}
