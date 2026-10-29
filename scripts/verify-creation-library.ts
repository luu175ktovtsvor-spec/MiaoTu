import { mapAsync } from '../server/async-collections.ts'
// Disposable files/SQLite and a loopback MCP server only. No model/upstream calls.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManagementStore } from '../server/management-store.ts'
import { WorkspaceFiles } from '../server/workspace-files.ts'
import { toolWorkspaceFiles } from '../server/tool-workspace-files.ts'
import { withRequestProject, withWorkspaceProject } from '../server/workspace-scope.ts'
import { createLibraryTools } from '../server/library-tools.ts'
import { createMcpApi } from '../server/mcp-api.ts'
import { json, sameOrigin } from '../server/http-auth.ts'

const root = await mkdtemp(join(tmpdir(), 'miao-creation-library-'))
const originalMedia = process.env.OIP_MEDIA_ROOT
process.env.OIP_MEDIA_ROOT = join(root, 'media')
const store = (await ManagementStore.open(':memory:'))
const files = (await WorkspaceFiles.open(store))
const guard = toolWorkspaceFiles(files)
const gallery = join(root, 'gallery')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7WQAAAAASUVORK5CYII=', 'base64')
let mcp, server
try {
  for (const path of ['inspiration/prompts', 'inspiration/translations', 'landing']) await mkdir(join(gallery, path), { recursive: true })
  const manifest = revision => ({ sourceRevision: revision, films: ['one', 'two'].map(id => ({
    id, title: [id], hasPrompt: true, promptFile: 'inspiration/prompts/a.json',
    translationFile: 'inspiration/translations/a.json', poster: `/landing/${id}.png`,
  })) })
  await writeFile(join(gallery, 'showcase-agent.json'), JSON.stringify(manifest('old')))
  await writeFile(join(gallery, 'inspiration/prompts/a.json'), JSON.stringify({ one: 'OLD', two: 'SECOND' }))
  await writeFile(join(gallery, 'inspiration/translations/a.json'), JSON.stringify({ one: { 'zh-Hans': '旧译文' } }))
  await writeFile(join(gallery, 'landing/one.png'), png)
  const asset = async () => new Response(png, { headers: { 'content-type': 'image/png' } })
  const archive = async input => {
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit'))
    const items = [0, 1, 2].map(id => ({ tweet_id: `archive-${id}`, prompt_text: `archived ${id}`, images: [] }))
    return Response.json({ dataset_version: 'archive-version', dataset_ready: true, dataset_manifest_match: true,
      total: items.length, offset, limit, items: items.slice(offset, offset + limit) })
  }
  const library = createLibraryTools({ showcaseRoot: gallery, showcaseAssetFetch: asset, fetchImpl: archive,
    env: { OIP_ARCHIVE_API_URL: 'http://127.0.0.1:9' }, workspaceFiles: guard.files, userId: call => call.userId })[0]
  const before = await library.execute({ source: 'showcase' })
  assert.equal(before.items[0].prompt, 'OLD')
  await writeFile(join(gallery, 'showcase-agent.json'), JSON.stringify(manifest('new')))
  await writeFile(join(gallery, 'inspiration/prompts/a.json'), JSON.stringify({ one: 'NEW', two: 'SECOND' }))
  await writeFile(join(gallery, 'inspiration/translations/a.json'), JSON.stringify({ one: { 'zh-Hans': '新译文' } }))
  const after = await library.execute({ source: 'showcase' })
  assert.equal(after.datasetVersion, 'new'); assert.equal(after.items[0].prompt, 'NEW')
  assert.equal(after.items[0].translations['zh-Hans'], '新译文')
  await writeFile(join(gallery, 'inspiration/prompts/a.json'), JSON.stringify({ one: 'SHARD_CHANGED', two: 'SECOND' }))
  assert.equal((await library.execute({ source: 'showcase' })).items[0].prompt, 'SHARD_CHANGED')
  for (const [offset, ids] of [[0, ['archive-0', 'archive-1', 'archive-2', 'showcase:one']],
    [2, ['archive-2', 'showcase:one', 'showcase:two']], [3, ['showcase:one', 'showcase:two']], [4, ['showcase:two']]] as const) {
    const page = await library.execute({ source: 'all', offset, limit: 4 })
    assert.equal(page.total, 5); assert.deepEqual(page.items.map(item => item.id), ids)
  }
  const partial = createLibraryTools({ showcaseRoot: gallery, env: { OIP_ARCHIVE_API_URL: 'http://127.0.0.1:9' },
    fetchImpl: async () => { throw new Error('fixture archive unavailable') } })[0]
  const partialPage = await partial.execute({ source: 'all', limit: 1 })
  assert.equal(partialPage.partial, true); assert.equal(partialPage.archiveDatasetReady, false)
  assert.equal(partialPage.showcaseDatasetReady, true); assert.equal(partialPage.items[0].source, 'showcase')

  const user = async name => (await store.createUser({ name, email: `${name}@example.invalid`, password: 'isolated-library-check', points: 0 }, 'verification')).user
  const a = (await user('library-a')), b = (await user('library-b'))
  const pa = (await store.createProject(a.id, 'A')), pb = (await store.createProject(b.id, 'B'))
  const tokens = (await mapAsync([a, b], async value => { const { token } = (await store.rotateMcpToken(value.id)); await store.setMcpEnabled(value.id, true); return token }))
  mcp = createMcpApi({ management: store, workspaceFiles: files, showcaseRoot: gallery, showcaseAssetFetch: asset })
  server = createServer(withRequestProject(async (req, res) => {
    try { await mcp.handleMcp(req, res, new URL(req.url || '/', 'http://localhost'), { json, sameOrigin }) }
    catch (error) { json(res, error.status || 500, { error: error.message }) }
  }))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = `http://127.0.0.1:${server.address().port}/mcp`
  const call = async (token, project) => {
    const response = await fetch(address, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-workspace-project': project,
      'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'searchInspirationLibrary', arguments: { source: 'showcase', limit: 1, saveReference: true },
    } }) })
    const text = await response.text()
    if (response.status !== 200) return { status: response.status }
    // Streamable HTTP responses prefix the JSON-RPC payload with an SSE event
    // line (`event: message`), so checking startsWith('data:') misses the
    // valid response and attempts to JSON.parse the whole SSE envelope.
    const dataLines = text.split(/\r?\n/).filter(line => line.startsWith('data:'))
    const message = dataLines.length
      ? dataLines.map(line => JSON.parse(line.slice(5).trim())).find(item => item.id === 1)
      : JSON.parse(text)
    assert.equal(message.result?.isError, undefined, text)
    return { status: response.status, value: JSON.parse(message.result.content[0].text) }
  }
  const [savedA, savedB] = await Promise.all([call(tokens[0], pa.id), call(tokens[1], pb.id)])
  assert.equal(savedA.status, 200); assert.equal(savedB.status, 200)
  assert.deepEqual((await files.read(a.id, savedA.value.savedReference.path, pa.id)).bytes, png)
  assert.deepEqual((await files.read(b.id, savedB.value.savedReference.path, pb.id)).bytes, png)
  await assert.rejects(async () => (await files.read(b.id, savedA.value.savedReference.path, pb.id)), error => (error as any)?.status === 404)
  assert.equal((await call(tokens[1], pa.id)).status, 404)
  assert.equal((await call('invalid-token', pa.id)).status, 401)
  await store.setMcpEnabled(a.id, false)
  assert.equal((await call(tokens[0], pa.id)).status, 401)

  const cancelledProject = (await store.createProject(a.id, 'cancelled'))
  const cancelled = new AbortController()
  let remoteReads = 0
  const cancellable = createLibraryTools({ showcaseRoot: gallery, workspaceFiles: guard.files, userId: a.id, env: {},
    showcaseAssetFetch: async () => { remoteReads++; cancelled.abort(new Error('fixture cancellation')); throw cancelled.signal.reason } })[0]
  await assert.rejects(withWorkspaceProject(cancelledProject.id, () => guard.run(() =>
    cancellable.execute({ source: 'showcase', limit: 2, saveReference: 2 }, { signal: cancelled.signal }))), /fixture cancellation/)
  assert.equal(remoteReads, 1); assert.equal((await files.list(a.id, cancelledProject.id)).length, 0)
  assert.equal((await files.list(a.id, pa.id)).length, 1); assert.equal((await files.list(b.id, pb.id)).length, 1)
  console.log('Creation library verified: cache refresh, provenance/partial results, merged pagination, byte-exact covers, MCP account/project/token isolation and cancellation rollback; no external calls.')
} finally {
  if (mcp) await mcp.stop()
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  await store.close()
  if (originalMedia === undefined) delete process.env.OIP_MEDIA_ROOT
  else process.env.OIP_MEDIA_ROOT = originalMedia
  await rm(root, { recursive: true, force: true })
}
