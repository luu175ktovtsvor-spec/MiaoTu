import { pluginExportNames, inspectPluginExports, readPluginMetadata } from './canvas-document.ts'
// 插件安装：从 URL 下载（公网校验 / 重定向 / 超时 / 大小上限）、版本比较、
// 节点脚本校验、技能包落盘。存储一律走账号工作区的文件与索引管理。
import { lookup } from 'node:dns/promises'
import { failure } from './management-store.ts'
import { MAX_ARCHIVE_BYTES, readSkillPackage } from './plugin-archive.ts'
import { privateHost } from './network/public-host.ts'
import { fetchPinnedResponse } from './network/pinned-fetch.ts'
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { parseFrontmatter as parsePiFrontmatter } from '@earendil-works/pi-coding-agent'
import { SKILL_NAME_PATTERN } from './skill-names.ts'
import { withRequestSignal } from './request-lifetime.ts'
import { incomingRequestSignal } from './http-request-lifetime.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const MAX_PLUGIN_BYTES = 20 * 1024 * 1024
const MAX_REDIRECTS = 5
const DOWNLOAD_TIMEOUT_MS = 30_000
export const MAX_VERSION_LENGTH = 256

export { SKILL_NAME_PATTERN }
const SKILL_ROOT = 'skills'

function invalid(message, status = 422) {
  return failure(message, status)
}

// ---- 下载 ----

// OIP_PLUGIN_ALLOW_PRIVATE_HOSTS 只给本地联调放开内网地址，默认关闭。
// ACT: 生产环境（NODE_ENV=production）忽略这个开关——容器环境变量会被部署脚本沿用，
// 不能让一个遗留变量在线上把内网拦截整体关掉。
function allowPrivateHosts() {
  return process.env.NODE_ENV !== 'production' && process.env.OIP_PLUGIN_ALLOW_PRIVATE_HOSTS === 'true'
}

async function assertPublicHost(hostname, signal: AbortSignal) {
  signal.throwIfAborted()
  const allowPrivate = allowPrivateHosts()
  if (!allowPrivate && privateHost(hostname)) throw invalid('这个下载地址不允许访问，请改用公网可访问的文件地址')
  let addresses
  try { addresses = await awaitWithContext(lookup(hostname, { all: true }), withAbortSignal(signal, BACKGROUND_CONTEXT)) }
  catch {
    signal.throwIfAborted()
    throw invalid('下载地址的域名无法解析，请检查域名拼写')
  }
  signal.throwIfAborted()
  if (!addresses.length || (!allowPrivate && addresses.some(address => privateHost(address.address)))) {
    throw invalid('这个下载地址不允许访问，请改用公网可访问的文件地址')
  }
  return addresses
}

function pluginAddress(value) {
  let address
  try { address = new URL(String(value || '').trim()) } catch { throw invalid('下载地址格式无效，请填写完整的 HTTP / HTTPS 文件地址') }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) {
    throw invalid('仅支持不含账号密码的 HTTP / HTTPS 地址')
  }
  return address
}

async function readBounded(response, limit, label, signal: AbortSignal) {
  const chunks = []
  let size = 0
  const reader = response.body.getReader()
  let cancelling: Promise<unknown> | undefined
  const cancel = () => { cancelling ??= reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.length
      if (size > limit) throw invalid(`${label}不能超过 ${Math.floor(limit / 1024 / 1024)} MB`, 413)
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally {
    signal.removeEventListener('abort', cancel)
    await (cancelling ?? reader.cancel().catch(() => {}))
    reader.releaseLock()
  }
}

export function withPluginInstall<T>(request: IncomingMessage, response: ServerResponse,
  helpers: { pluginSignal?: AbortSignal; assertPluginScope?: () => void },
  operation: (control: { signal: AbortSignal; assertCurrent(): void }) => T | Promise<T>) {
  return withRequestSignal(request, response, incomingRequestSignal(request, helpers.pluginSignal), signal => {
    const assertCurrent = () => { signal.throwIfAborted(); helpers.assertPluginScope?.() }
    assertCurrent()
    return operation({ signal, assertCurrent })
  })
}

function downloadFailure(status, label) {
  const hint = status === 401 || status === 403 ? '下载被拒绝，链接可能已过期、签名无效或没有访问权限'
    : status === 404 ? '文件不存在，请确认路径和文件名'
    : status === 410 ? '文件已失效，请获取新的下载链接'
    : status === 429 ? '下载请求过于频繁，请稍后重试'
    : status >= 500 ? '对方服务器暂时异常，请稍后重试'
    : '对方服务器没有返回文件'
  return invalid(`${label}下载失败（HTTP ${status}）：${hint}`, 502)
}

// 名字要在下载前定下来，所以 URL 的形态先单独校验一次，报错才落在地址上。
export function assertPluginUrl(value) {
  return pluginAddress(value).toString()
}

export async function downloadPluginFile(rawUrl, { limitBytes = MAX_PLUGIN_BYTES, label = '文件', signal: parent }: Record<string, any> = {}, { fetchImpl = fetch }: Record<string, any> = {}) {
  parent?.throwIfAborted()
  let address = pluginAddress(rawUrl)
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const resolved = await assertPublicHost(address.hostname.replace(/^\[|\]$/g, ''), signal)
      signal.throwIfAborted()
      const response = await fetchPinnedResponse(address, resolved, { signal, headers: { accept: '*/*' }, fetchImpl })
      try {
        signal.throwIfAborted()
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel().catch(() => {})
          if (!location) throw invalid(`${label}下载失败：跳转响应缺少 Location 地址`, 502)
          if (hop === MAX_REDIRECTS) throw invalid(`${label}下载失败：跳转超过 ${MAX_REDIRECTS} 次，请使用文件的直接下载地址`, 502)
          try { address = pluginAddress(new URL(location, address).href) }
          catch { throw invalid(`${label}下载失败：跳转目标不是有效的 HTTP / HTTPS 地址`, 502) }
          continue
        }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw downloadFailure(response.status, label) }
        if (!response.body) throw invalid(`${label}下载失败：对方服务器没有返回内容`, 502)
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > limitBytes) {
          await response.body.cancel().catch(() => {})
          throw invalid(`${label}不能超过 ${Math.floor(limitBytes / 1024 / 1024)} MB`, 413)
        }
        const bytes = await readBounded(response, limitBytes, label, signal)
        signal.throwIfAborted()
        if (!bytes.byteLength) throw invalid(`${label}下载失败：文件内容为空`, 502)
        return bytes
      } finally { await response.body?.cancel().catch(() => {}) }
    }
  } catch (error) {
    parent?.throwIfAborted()
    if (error?.status) throw error
    if (timeout.aborted) throw invalid(`${label}下载超时（${DOWNLOAD_TIMEOUT_MS / 1000} 秒），请检查网络后重试`, 504)
    throw invalid(`${label}下载连接失败，请检查网络、域名和 HTTPS 证书后重试`, 502)
  }
  throw invalid(`${label}下载失败：地址无效`, 502)
}

// ---- 版本 ----

// 完整 SemVer 才参与比较；缺失或非法一律返回 undefined，不猜更新顺序。
function semver(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_VERSION_LENGTH) return undefined
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim())
  if (!match) return undefined
  const numbers = match.slice(1, 4).map(value => BigInt(value))
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some(part => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))) return undefined
  return { numbers, prerelease }
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] < right.numbers[index] ? -1 : 1
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0
  if (!left.prerelease.length) return 1
  if (!right.prerelease.length) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumber = /^\d+$/.test(a)
    const bNumber = /^\d+$/.test(b)
    // Prerelease numeric identifiers can exceed Number's exact integer range.
    if (aNumber && bNumber) return BigInt(a) < BigInt(b) ? -1 : 1
    if (aNumber !== bNumber) return aNumber ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

export function requireNewerVersion(current, incoming, label) {
  const installed = semver(current)
  const next = semver(incoming)
  if (!installed || !next) {
    throw invalid(`${label}已安装，但现有或待安装版本缺失或无效，无法判断更新顺序；需要覆盖时请在开发者选项里打开「强制安装」`, 409)
  }
  if (compareVersions(next, installed) <= 0) {
    throw invalid(`${label}已安装 ${current}，待安装 ${incoming} 不高于现有版本；需要覆盖或降级时请在开发者选项里打开「强制安装」`, 409)
  }
}

// ---- 节点脚本 ----

// 版本可以写在构建设备标记里：/*! miaoimgNode:{"version":"1.2.3"} */
export function nodeBundleVersion(source) {
  try {
    const value = readPluginMetadata(String(source || ''), 'node') as { version?: unknown } | null
    return typeof value?.version === 'string' ? value.version : undefined
  } catch { return undefined }
}

export function validateNodeBundle(name, source) {
  if (!/^[a-z][a-zA-Z0-9]{1,40}$/.test(String(name || ''))) throw invalid('节点名必须是字母开头、仅含字母数字的小驼峰')
  const text = String(source || '')
  if (!text.trim()) throw invalid('节点脚本不能为空')
  if (Buffer.byteLength(text, 'utf8') > MAX_PLUGIN_BYTES) throw invalid('节点脚本不能超过 20 MB', 413)
  if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text)) throw invalid('这个文件是网页而不是节点脚本，请上传构建生成的 .umd.js')
  if (!pluginExportNames('node').some(name => text.includes(name))) throw invalid('这个文件不是节点插件，请上传构建生成的 .umd.js')
  // 只在能确凿读出导出名时才比对：按变量导出（miaoimgNodes[name]）的 bundle 不误伤，
  // 真正的导出名不匹配交给画布加载时的报错兜底。
  // 只认 miaoimgNodes.foo 与 miaoimgNodes["foo"] 两种字面写法；miaoimgNodes[name] 读不出值，跳过。
  const exported = inspectPluginExports(text, 'node')
  if (exported.length && !exported.includes(name)) {
    throw invalid(`文件里导出的是节点「${exported[0]}」，与文件名「${name}」不一致，请改成一致的名称`)
  }
  return text
}

// ---- 技能包 ----

// Install and discovery use the same Pi/YAML parser, including quoted text,
// multiline descriptions and inline metadata. Never rewrite the source bytes.
export function parseFrontmatter(text): Record<string, any> {
  try {
    const { frontmatter } = parsePiFrontmatter(String(text || ''))
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) throw new Error('invalid metadata')
    return frontmatter
  } catch { throw invalid('SKILL.md 的 frontmatter 不是有效的 YAML 对象') }
}

function skillFilePath(name, relative?: any) {
  return relative ? `${SKILL_ROOT}/${name}/${relative}` : `${SKILL_ROOT}/${name}/SKILL.md`
}

export function listInstalledSkills(workspaceFiles, userId) {
  const prefix = `${SKILL_ROOT}/`
  return [...new Set(workspaceFiles.list(userId)
    .filter(entry => entry.path.startsWith(prefix) && entry.path.endsWith('/SKILL.md'))
    .map(entry => entry.path.slice(prefix.length, -'/SKILL.md'.length)))]
}

export function installSkillPackage({ workspaceFiles, userId, fileName, bytes, force = false }: Record<string, any>) {
  const safeName = String(fileName || '')
  if (!safeName || safeName.length > 128 || /[\\/]/.test(safeName)) throw invalid('技能文件名无效')
  if (!bytes?.byteLength) throw invalid('技能文件不能为空')
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw invalid('技能文件不能超过 20 MB', 413)
  const files = readSkillPackage(safeName, bytes)

  const manifests = [...files.keys()].filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
  if (manifests.length !== 1) throw invalid('技能包必须包含且仅包含一个 SKILL.md')
  const manifest = manifests[0]
  const prefix = manifest.slice(0, -'SKILL.md'.length)
  if ([...files.keys()].some(path => !path.startsWith(prefix))) throw invalid('技能资源必须位于 SKILL.md 所在目录内')

  let frontmatter
  try { frontmatter = parseFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(files.get(manifest))) }
  catch (error) { if (error?.status) throw error; throw invalid('SKILL.md 内容不是有效的 UTF-8 文本') }
  const name = frontmatter.name
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) throw invalid('SKILL.md 的 name 必须是 1 到 64 个字母、数字、点、下划线或短横线，且以字母或数字开头')
  if (name === '.' || name === '..') throw invalid('SKILL.md 的 name 无效')
  const description = frontmatter.description
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) throw invalid('SKILL.md 的 description 必须是 1 到 1024 个字符')
  const version = frontmatter.metadata?.version

  // 「已安装」以 SKILL.md 为准：只有引用文件残留的目录算残留，直接覆盖，不当成已有版本。
  const entries = workspaceFiles.list(userId)
  const installed = entries.some(entry => entry.path === skillFilePath(name))
  if (installed && !force) requireNewerVersion(readInstalledSkillVersion(workspaceFiles, userId, name), version, `技能「${name}」`)
  const target = `${SKILL_ROOT}/${name}`
  const prepared = [...files].map(([path, bytes]) => ({ path: skillFilePath(name, path.slice(prefix.length)), mime: 'text/markdown', bytes }))
  const installedFiles = workspaceFiles.replaceTree(userId, target, prepared, {
    expected: entries.filter(entry => entry.path === target || entry.path.startsWith(target + '/')),
  })
  return { name, description, version: typeof version === 'string' ? version : '', files: installedFiles.files, replaced: installed }
}

function readInstalledSkillVersion(workspaceFiles, userId, name) {
  // bytes 是 Uint8Array，必须过一层 Buffer 才能按 utf8 解码。
  try { return parseFrontmatter(Buffer.from(workspaceFiles.read(userId, skillFilePath(name)).bytes).toString('utf8')).metadata?.version }
  catch { return undefined }
}
