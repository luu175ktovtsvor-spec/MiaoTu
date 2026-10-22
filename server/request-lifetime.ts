import type { IncomingMessage, ServerResponse } from 'node:http'

// A completed request body does not mean the response consumer is still there.
// Stop its upstream work on disconnect and remove both listeners on completion.
export async function withRequestSignal<T>(request: IncomingMessage, response: ServerResponse,
  parent: AbortSignal | undefined, operation: (signal: AbortSignal) => T | Promise<T>) {
  const controller = new AbortController()
  const abort = () => { if (!response.writableEnded) controller.abort() }
  request.once('aborted', abort)
  response.once('close', abort)
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  try {
    if (request.aborted || response.destroyed) controller.abort()
    signal.throwIfAborted()
    return await operation(signal)
  } finally {
    request.off('aborted', abort)
    response.off('close', abort)
  }
}
