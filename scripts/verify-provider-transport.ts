import assert from 'node:assert/strict'
import { createProviderTransport } from '../server/provider-transport.ts'
const relayUrl = 'https://admin.miaoimg.cn/__miaoimg-provider/request'
const target = 'https://api.suihemedia.cloud/v1/tasks'
const token = 'test-only-relay-token-not-a-live-credential'
{
  const calls: any[] = []
  const fetch = createProviderTransport(async (input, init) => {
    calls.push({ input: String(input), init })
    assert.equal(String(input), relayUrl)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer ' + token)
    const upstream = new Headers(JSON.parse(Buffer.from(headers.get('x-miao-upstream-headers')!, 'base64').toString()))
    assert.equal(upstream.get('authorization'), 'Bearer supplier-test-key')
    assert.equal(headers.get('x-miao-upstream-url'), target)
    assert.equal(await new Response(init?.body).text(), 'one submission')
    return Response.json({ accepted: true })
  }, { relayUrl, token, probe: async () => false })
  assert.equal((await fetch(target, { method: 'POST', body: 'one submission', headers: { authorization: 'Bearer supplier-test-key' } })).status, 200)
  assert.equal(calls.length, 1)
}
{
  const form = new FormData()
  form.append('file', new Blob(['reference bytes'], { type: 'image/png' }), 'reference.png')
  const fetch = createProviderTransport(async (_input, init) => {
    const headers = new Headers(init?.headers)
    const upstream = new Headers(JSON.parse(Buffer.from(headers.get('x-miao-upstream-headers')!, 'base64').toString()))
    const type = upstream.get('content-type')!
    assert.match(type, /^multipart\/form-data; boundary=/)
    const body = await new Response(init?.body).text()
    assert.ok(body.includes('--' + type.split('boundary=')[1]))
    assert.ok(body.includes('reference bytes'))
    return Response.json({ ok: true })
  }, { relayUrl, token, probe: async () => false })
  await fetch(target, { method: 'POST', body: form })
}
{
  const calls: string[] = []
  const fetch = createProviderTransport(async (input, init) => {
    calls.push(String(input))
    if (init?.method === 'POST') throw new TypeError('reply lost after submission')
    return Response.json({ accepted: true })
  }, { relayUrl, token, probe: async () => true })
  await assert.rejects(fetch(target, { method: 'POST', body: 'accepted once' }), /reply lost/)
  assert.deepEqual(calls, [target])
  await fetch(target + '/existing-task')
  assert.deepEqual(calls, [target, relayUrl])
}
{
  const calls: string[] = []
  const fetch = createProviderTransport(async input => { calls.push(String(input)); return new Response(null, { status: 302, headers: { location: 'https://unrelated.example/' } }) }, { relayUrl, token, probe: async () => false })
  await assert.rejects(fetch(target), /redirect/)
  assert.deepEqual(calls, [relayUrl])
}
{
  const calls: string[] = []
  let probed = false
  const fetch = createProviderTransport(async input => { calls.push(String(input)); return Response.json({ ok: true }) }, { relayUrl, token, probe: async () => { probed = true; return false } })
  await fetch('https://video.twimg.com/public.mp4')
  assert.deepEqual(calls, ['https://video.twimg.com/public.mp4'])
  assert.equal(probed, false)
}
assert.throws(() => createProviderTransport(fetch, { relayUrl: 'https://unrelated.example/', token }), /Invalid/)
console.log('供应商自动选路验证通过：先探测、单次提交、查询改道、禁止跳转泄露凭据、固定中继范围。')
