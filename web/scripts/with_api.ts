#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { spawnPython } from '../../scripts/run_python.ts'
import { loadPaymentEnvironment } from '../../server/payment-secrets.ts'
import { runtimeSecret } from '../../server/runtime-secrets.ts'
import { assertMockProviderConfiguration, isMockProviderMode } from '../../server/provider-safety.ts'
import { ManagementStore } from '../../server/management-store.ts'
import { ServiceChildren, waitForVite } from './service-children.ts'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(webRoot, '..')
const mode = process.argv[2] === 'preview' ? 'preview' : 'dev'

function loadKeychainSecret(service, envName) {
  if (process.platform !== 'darwin' || runtimeSecret(envName) || process.env.OIP_ALLOW_KEYCHAIN !== '1' || isMockProviderMode(process.env)) return
  try {
    const value = execFileSync('/usr/bin/security', [
      'find-generic-password', '-a', process.env.USER || 'cch',
      '-s', service, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (value) process.env[envName] = value
  } catch {
    // Local development can still render the UI without a configured provider.
  }
}

loadKeychainSecret('open-image-prompts-ark-api-key', 'ARK_API_KEY')
loadKeychainSecret('open-image-prompts-yunshu-api-key', 'YUNSHU_API_KEY')
loadKeychainSecret('open-image-prompts-metaso-api-key', 'METASO_API_KEY')

if (!isMockProviderMode(process.env)) {
  loadPaymentEnvironment(process.env.OIP_PAYMENT_CREDENTIALS_FILE || resolve(repositoryRoot, 'secrets/zpay-api.md'))
}
// Fail before forking any API child.  In mock mode an omitted channel or a
// real-looking endpoint is a startup error, never a deferred network call.
assertMockProviderConfiguration(process.env)

// The image and admin APIs share the management database.  Both processes used
// to run the schema migration at the same time on a fresh checkout, which can
// make SQLite report "database is locked" before either service is ready.  Run
// the one-time schema/recovery pass in this parent process before forking the
// two children so their first connection only opens an existing schema.
//
// 这个进程的 cwd 是 web/（npm --prefix 会把脚本的 cwd 设成包目录），而两个子进程的
// cwd 是仓库根（见下面的 spawn）。默认数据目录是相对路径，如果不显式给出绝对路径，
// 这里预热的会是 web/data/management.sqlite 这个「另一个库」：它只有 schema、没有数据，
// 还会让启动日志报出「工作区结构处于迁移中间态」这种吓人的假警告，而真正在用的
// data/management.sqlite 根本没被预热。所以这里按子进程的解析口径显式算出路径。
const configuredManagementDb = process.env.OIP_MANAGEMENT_DB
const managementDbPath = configuredManagementDb
  ? (configuredManagementDb === ':memory:' ? configuredManagementDb : resolve(repositoryRoot, configuredManagementDb))
  : resolve(repositoryRoot, process.env.OIP_DATA_DIR || 'data', 'management.sqlite')
const managementBootstrap = (await ManagementStore.open(managementDbPath))
await managementBootstrap.close()

function optionalPort(value, name) {
  if (!value) return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535, received: ${value}`)
  }
  return port
}

// The first start expands an 80 MB archive into a ~270 MB SQLite database and
// warms the gallery filters. That is a couple of seconds on a fast local disk
// but far slower on constrained CI runners, where a 30s budget used to abort a
// start that was still making progress. Readiness is decided by probing /health,
// so a generous ceiling costs nothing when startup is quick.
function startupTimeoutMs() {
  const raw = globalThis.process?.env.OIP_STARTUP_TIMEOUT?.trim()
  if (!raw) return 180_000
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(seconds * 1000)) {
    throw new Error(`OIP_STARTUP_TIMEOUT must be a positive number of seconds, received: ${raw}`)
  }
  return seconds * 1000
}

async function freeLoopbackPort(excluded: Set<string>) {
  while (true) {
    const port = await new Promise<string>((resolvePromise, reject) => {
      const server = createNetServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        server.close((error) => error ? reject(error) : resolvePromise(String(port)))
      })
    })
    if (!excluded.has(port)) { excluded.add(port); return port }
  }
}

// Keep the management service on a stable port, matching Sub2API's
// configuration-driven server port. Validate it before starting any child so
// a bad override cannot leave an image API process behind.
const adminApiPort = String(optionalPort(process.env.OIP_ADMIN_PORT, 'OIP_ADMIN_PORT') || 4184)
const archiveEnabled = process.env.OIP_ENABLE_ARCHIVE !== 'false'
const configuredApiPort = optionalPort(process.env.OIP_API_PORT, 'OIP_API_PORT')
const configuredImagePort = optionalPort(process.env.OIP_IMAGE_API_PORT, 'OIP_IMAGE_API_PORT')
const webPort = optionalPort(process.env.OIP_WEB_PORT, 'OIP_WEB_PORT')
const budget = startupTimeoutMs()
const excluded = new Set([adminApiPort, ...[configuredApiPort, configuredImagePort, webPort].filter(Boolean).map(String)])
// Resolve every asynchronous port allocation before there is an API to orphan.
const apiPort = configuredApiPort ? String(configuredApiPort) : archiveEnabled ? await freeLoopbackPort(excluded) : '8787'
const imageApiPort = configuredImagePort ? String(configuredImagePort) : await freeLoopbackPort(excluded)
process.env.OIP_ADMIN_PORT = adminApiPort
process.env.OIP_API_PORT = apiPort
process.env.OIP_IMAGE_API_PORT = imageApiPort
// Agent/MCP 的档案服务地址显式注入；生产由部署脚本传入，开发才使用本机子进程端口。
if (archiveEnabled && !process.env.OIP_ARCHIVE_API_URL) process.env.OIP_ARCHIVE_API_URL = `http://127.0.0.1:${apiPort}`
const services = new ServiceChildren((name, event) => console.error(`${name} ${event}`))
void services.closed.then(code => { process.exitCode = code })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void services.stop() })

async function waitForApi() {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    services.signal.throwIfAborted()
    try {
      const ports = [imageApiPort, adminApiPort, ...(archiveEnabled ? [apiPort] : [])]
      const checks = ports.map(async port => {
        const signal = AbortSignal.any([services.signal, AbortSignal.timeout(Math.min(3000, Math.max(1, deadline - Date.now())))])
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal })
        try { return response.ok }
        finally { await response.body?.cancel().catch(() => {}) }
      })
      // Join every admitted probe, including those still receiving headers
      // after a sibling fails; none may remain detached from startup.
      const results = await Promise.allSettled(checks)
      services.signal.throwIfAborted()
      if (results.every(result => result.status === 'fulfilled' && result.value)) return
    } catch {
      services.signal.throwIfAborted()
      // The API is still starting.
    }
    await new Promise<void>((resolvePromise, reject) => {
      const cancelled = () => { clearTimeout(timer); services.signal.removeEventListener('abort', cancelled); reject(services.signal.reason) }
      const timer = setTimeout(() => { services.signal.removeEventListener('abort', cancelled); resolvePromise() }, 100)
      services.signal.addEventListener('abort', cancelled, { once: true })
      if (services.signal.aborted) cancelled()
    })
  }
  throw new Error(
    `SQLite API did not become ready within ${budget / 1000} seconds. `
    + 'The first start expands the SQLite archive, which is slow on constrained '
    + 'machines; raise OIP_STARTUP_TIMEOUT (seconds) if it needs longer.',
  )
}

try {
  if (archiveEnabled) services.spawn('SQLite API', () => spawnPython([resolve(repositoryRoot, 'server/miaoimg_api.py')], {
    cwd: repositoryRoot, env: { ...process.env }, stdio: 'inherit',
  }))
  services.spawn('Image API', () => spawn(process.execPath, [resolve(repositoryRoot, 'server/image_api.ts')], {
    cwd: repositoryRoot, env: { ...process.env }, stdio: 'inherit',
  }))
  services.spawn('Admin API', () => spawn(process.execPath, [resolve(repositoryRoot, 'server/admin_server.ts')], {
    cwd: repositoryRoot, env: { ...process.env }, stdio: 'inherit',
  }))
  await waitForApi()
  services.signal.throwIfAborted()
  const web = services.spawn('Web service', () => spawn(process.execPath, [resolve(webRoot, 'scripts/vite-server.ts'), mode], {
    cwd: webRoot, env: { ...process.env }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  }), { sigtermExitCodes: [143] })
  await waitForVite(web, services.signal)
} catch (error) {
  if (!services.stopping) {
    console.error(error instanceof Error ? error.message : String(error))
    void services.stop(1)
  }
} finally { services.finishStartup() }
// Startup never waits on its own shutdown barrier. Only its completed caller
// joins the cached stop promise, including all real child close events.
if (services.stopping) await services.closed
