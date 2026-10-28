import assert from 'node:assert/strict'
import { createCloudTransport } from '../desktop/cloud-transport.ts'

const main = 'https://miaoimg.cn'
const relay = 'https://admin.miaoimg.cn'
const ok = () => Response.json({ ok: true })
const urlOf = input => new URL(String(input))

// Choose the relay before sending a paid/upload request, without moving the
// account origin or putting credentials in connectivity probes.
{
  const calls: any[] = []
  const fetch = createCloudTransport(async (input, init = {}) => {
    const url = urlOf(input); calls.push({ url, init })
    if (url.pathname === '/health') {
      assert.equal(new Headers(init.headers).has('cookie'), false)
      assert.equal(new Headers(init.headers).has('authorization'), false)
      if (url.origin === main) throw new TypeError('connection failed')
      return ok()
    }
    assert.equal(url.origin, relay)
    assert.equal(new Headers(init.headers).get('origin'), main)
    assert.equal(new Headers(init.headers).get('cookie'), 'miao_session=test')
    return Response.json({ accepted: true })
  })
  await fetch(main + '/api/imagine/video', { method: 'POST', body: 'one submission', headers: { origin: main, cookie: 'miao_session=test' } })
  assert.equal(calls.filter(x => x.init.method === 'POST').length, 1)
}

// A connection can fail after the server accepted a POST. Never replay it.
{
  let posts = 0
  const fetch = createCloudTransport(async (input, init = {}) => {
    const url = urlOf(input)
    if (url.pathname === '/health') return ok()
    if (init.method === 'POST') { posts++; throw new TypeError('reply lost after acceptance') }
    assert.equal(url.origin, relay)
    return Response.json({ state: 'accepted' })
  })
  await assert.rejects(fetch(main + '/api/imagine/video', { method: 'POST', body: 'accepted once' }), /reply lost/)
  assert.equal(posts, 1)
  assert.equal((await (await fetch(main + '/api/imagine/video/request-1')).json()).state, 'accepted')
  assert.equal(posts, 1)
}

// A read that failed before response headers may take the alternate route.
{
  const reads: string[] = []
  const fetch = createCloudTransport(async input => {
    const url = urlOf(input)
    if (url.pathname === '/health') return ok()
    reads.push(url.origin)
    if (url.origin === main) throw new TypeError('connection reset')
    return ok()
  })
  assert.equal((await fetch(main + '/api/imagine/config')).status, 200)
  assert.deepEqual(reads, [main, relay])
}

// HTTP authentication/server errors are real responses, not route failures.
{
  const calls: string[] = []
  const fetch = createCloudTransport(async input => {
    const url = urlOf(input); calls.push(url.origin)
    return url.pathname === '/health' ? ok() : new Response(null, { status: 401 })
  })
  assert.equal((await fetch(main + '/api/imagine/session')).status, 401)
  assert.deepEqual(calls, [main, main])
}

// Cancelling one caller must not abort the probe shared by another caller.
{
  let finish: (() => void) | undefined
  let probes = 0
  const pending = new Promise<void>(resolve => { finish = resolve })
  const fetch = createCloudTransport(async input => {
    if (urlOf(input).pathname === '/health') { probes++; await pending }
    return ok()
  })
  const controller = new AbortController()
  const first = fetch(main + '/api/imagine/config', { signal: controller.signal })
  const second = fetch(main + '/api/imagine/session')
  controller.abort(new DOMException('cancelled', 'AbortError'))
  await assert.rejects(first, { name: 'AbortError' })
  finish!()
  assert.equal((await second).status, 200)
  assert.equal(probes, 1)
}

// Recover the direct route after its cooldown instead of staying on the relay.
{
  let clock = 1
  let directUp = false
  const routes: string[] = []
  const fetch = createCloudTransport(async input => {
    const url = urlOf(input)
    if (url.pathname === '/health') {
      if (url.origin === main && !directUp) throw new TypeError('direct unavailable')
      return ok()
    }
    routes.push(url.origin); return ok()
  }, { now: () => clock, retryAfterMs: 10 })
  await fetch(main + '/api/imagine/config')
  clock = 12; directUp = true
  await fetch(main + '/api/imagine/config')
  assert.deepEqual(routes, [relay, main])
}

// A private candidate must never fall through to production, and unrelated
// download URLs must never forward their credentials to either account host.
{
  const seen: string[] = []
  const base = async input => { seen.push(String(input)); return ok() }
  await createCloudTransport(base, { primaryOrigin: 'http://127.0.0.1:5175' })('http://127.0.0.1:5175/api/imagine/config')
  await createCloudTransport(base)('https://supplier.example/file')
  assert.deepEqual(seen, ['http://127.0.0.1:5175/api/imagine/config', 'https://supplier.example/file'])
}

console.log('云端自动选路验证通过：连接探测、备用线路、恢复、取消隔离、凭据边界与禁止重放提交。')
