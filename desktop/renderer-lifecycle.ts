import { randomUUID } from 'node:crypto'

// A document's JS can disappear before an accepted HTTP write finishes. The
// native host retires its epoch, fences late requests, then waits for the actual
// handlers before releasing that document's editor protection.
export function createRendererLifecycle({ detached = (_id: string) => {}, drained = (_id: string) => {} } = {}) {
  type Document = { id: string; ready: Promise<void>; jobs: Set<Promise<unknown>>; responses: Set<any> }
  let current: Document | undefined, enabled = false
  let barrier = Promise.resolve()
  const stale = () => Object.assign(new Error('工作区页面已更新，本次旧页面请求未执行，请重新读取'), { status: 409 })
  function retire() {
    const previous = current
    if (!previous) return
    current = undefined
    detached(previous.id)
    for (const response of previous.responses) response.destroy()
    const jobs = [...previous.jobs]
    barrier = previous.ready.then(() => Promise.allSettled(jobs)).then(() => {
      // A handler that was already preparing a stream must not register an old
      // controller after the first close pass.
      detached(previous.id)
      drained(previous.id)
    })
    void barrier.catch(() => {})
  }
  function committed() {
    retire()
    enabled = true
    current = { id: randomUUID(), ready: barrier, jobs: new Set(), responses: new Set() }
  }
  async function run(request, response, action: () => Promise<unknown>) {
    if (!enabled || !(request.url || '').startsWith('/api/')) return action()
    const id = request.headers['x-miaoimg-document']
    // Element media URLs do not use fetch and have no JS epoch. They are reads;
    // API mutations and control streams require the current document binding.
    if (!id && ['GET', 'HEAD'].includes(request.method) && !/\/control\//.test(request.url)) return action()
    const document = current
    if (!document || id !== document.id) throw stale()
    document.responses.add(response)
    const closed = () => { document.responses.delete(response); response.off('close', closed); response.off('finish', closed) }
    response.once('close', closed); response.once('finish', closed)
    const operation = (async () => {
      await document.ready
      if (current !== document) throw stale()
      return action()
    })()
    document.jobs.add(operation)
    void operation.then(() => document.jobs.delete(operation), () => document.jobs.delete(operation))
    return operation
  }
  return {
    committed, retire, run,
    epoch() { if (!current) throw stale(); return current.id },
    wait: () => barrier,
  }
}
