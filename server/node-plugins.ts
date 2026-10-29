import { isWorkspaceRequest } from './canvas-document.ts'
// 节点插件：MiaoImg 的 /api/nodes/get + /api/nodes/files 在妙图里的实现。
// 插件是 UMD bundle（构建时把 vue / @vue-flow/core / element-plus 外置到
// window.miaoimgNodeHost），安装后按账号存进工作区，画布按需加载。
import { failure } from './management-store.ts'
import { MAX_PLUGIN_BYTES, MAX_VERSION_LENGTH, assertPluginUrl, downloadPluginFile, installSkillPackage, nodeBundleVersion, requireNewerVersion, validateNodeBundle, withPluginInstall } from './plugin-install.ts'
import { MAX_ARCHIVE_BYTES } from './plugin-archive.ts'

const BUILTIN_NODES = [
  { name: 'textNode', displayName: '文本' },
  { name: 'imageNode', displayName: '图片' },
  { name: 'videoNode', displayName: '视频' },
  { name: 'audioNode', displayName: '音频' },
  { name: 'imageGenerationNode', displayName: '图片生成' },
  { name: 'videoGenerationNode', displayName: '视频生成' },
  { name: 'director3dNode', displayName: '导演台' },
]

const META_PATH = 'nodes/plugins.json'
// 节点脚本是文本、技能包走 base64，两种请求体都要装得下 20MB 的成品。
const NODE_INSTALL_BODY_BYTES = 22 * 1024 * 1024
const SKILL_INSTALL_BODY_BYTES = 30 * 1024 * 1024

// 从链接安装时用地址里的文件名推断节点名，例如 .../audioNode.umd.js → audioNode。
function fileNameFromUrl(rawUrl) {
  if (!rawUrl) return ''
  try { return (decodeURIComponent(new URL(rawUrl).pathname).split('/').pop() || '').slice(0, 128) } catch { return '' }
}

function nodeNameFromUrl(rawUrl) {
  return fileNameFromUrl(rawUrl).replace(/\.umd\.js$/i, '').replace(/[^A-Za-z0-9]/g, '')
}

// 配置声明：插件在 bundle 头部写一条注释，安装时静态提取（不执行脚本）：
//   /*! miaoimgNode:{"config":[{"key":"endpoint","label":"接口地址","type":"string","required":true}]} */
// 注释体必须是不含 * / 的 JSON；扫不到声明就当作没有配置项。
const CONFIG_MARKER = '/*! miaoimgNode:'
const CONFIG_SCAN_BYTES = 64 * 1024
const MAX_CONFIG_FIELDS = 24
const MAX_OPTIONS = 50
const MAX_STRING_LENGTH = 2000
const CONFIG_BODY_BYTES = 256 * 1024
const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/
const FIELD_TYPES = ['string', 'number', 'boolean', 'select']

export function validNodeName(value) {
  return /^[a-z][a-zA-Z0-9]{1,40}$/.test(String(value || ''))
}

// 密钥类字段（type: password / secret: true）不接入配置体系：配置会随
// /api/nodes/get 下发到浏览器，而妙图的密钥一律只留在服务端。
function isSecretField(item) {
  return item?.secret === true || String(item?.type || '').toLowerCase() === 'password'
}

function normalizeConfigField(item, seen) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw failure('插件配置项格式无效', 422)
  const key = String(item.key || '').trim()
  if (!FIELD_KEY.test(key)) throw failure(`插件配置项的 key 无效：${key || '(空)'}`, 422)
  if (seen.has(key)) throw failure(`插件配置项 ${key} 重复声明`, 422)
  seen.add(key)
  const label = String(item.label || '').trim().slice(0, 60)
  if (!label) throw failure(`插件配置项 ${key} 缺少 label`, 422)
  const type = String(item.type || 'string').trim()
  if (!FIELD_TYPES.includes(type)) throw failure(`插件配置项 ${key} 的 type 只能是 ${FIELD_TYPES.join(' / ')}`, 422)
  const field: Record<string, any> = { key, label, type, required: item.required === true }
  const text = (value, limit) => String(value ?? '').trim().slice(0, limit)
  if (type === 'select') {
    const options = Array.isArray(item.options) ? item.options.slice(0, MAX_OPTIONS) : []
    const values = new Set()
    field.options = options.map(option => {
      const value = text(option?.value, 120)
      if (!value || values.has(value)) throw failure(`插件配置项 ${key} 的 options 无效`, 422)
      values.add(value)
      return { value, label: text(option?.label, 60) || value }
    }).filter(option => option.value)
    if (field.options.length < 1) throw failure(`插件配置项 ${key} 是下拉选择，必须给出 options`, 422)
  }
  if (type === 'number') {
    for (const bound of ['min', 'max']) {
      if (item[bound] === undefined || item[bound] === null || item[bound] === '') continue
      const value = Number(item[bound])
      if (!Number.isFinite(value)) throw failure(`插件配置项 ${key} 的 ${bound} 需要是数字`, 422)
      field[bound] = value
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw failure(`插件配置项 ${key} 的 min 大于 max`, 422)
  }
  if (type === 'string') {
    const limit = item.maxLength === undefined ? 500 : Number(item.maxLength)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STRING_LENGTH) throw failure(`插件配置项 ${key} 的 maxLength 需要在 1 到 ${MAX_STRING_LENGTH} 之间`, 422)
    field.maxLength = limit
  }
  if (item.default !== undefined) field.default = item.default
  if (item.placeholder) field.placeholder = text(item.placeholder, 120)
  if (item.description) field.description = text(item.description, 200)
  return field
}

function parseConfigDeclaration(bundle) {
  const head = bundle.slice(0, CONFIG_SCAN_BYTES)
  const start = head.indexOf(CONFIG_MARKER)
  if (start < 0) return { rules: [], secretFields: [] }
  const end = head.indexOf('*/', start + CONFIG_MARKER.length)
  if (end < 0) throw failure('插件配置声明缺少结尾的 */', 422)
  let parsed
  try { parsed = JSON.parse(head.slice(start + CONFIG_MARKER.length, end)) } catch { throw failure('插件配置声明不是合法 JSON', 422) }
  const items = Array.isArray(parsed?.config) ? parsed.config : null
  if (!items) throw failure('插件配置声明缺少 config 数组', 422)
  if (items.length > MAX_CONFIG_FIELDS) throw failure(`插件配置项不能超过 ${MAX_CONFIG_FIELDS} 个`, 422)
  const secretFields = []
  const seen = new Set()
  const rules = []
  for (const item of items) {
    if (isSecretField(item)) { secretFields.push(String(item?.key || '').trim() || '(未命名)'); continue }
    rules.push(normalizeConfigField(item, seen))
  }
  return { rules, secretFields }
}

// 按声明把原始值收敛成可存储的形态；enforceRequired 为 false 时用于求默认值。
function coerceConfigValue(field, raw, enforceRequired) {
  if (field.type === 'boolean') {
    if (raw === undefined || raw === null || raw === '') return false
    if (typeof raw !== 'boolean') throw failure(`「${field.label}」需要是开关值`, 422)
    return raw
  }
  if (field.type === 'number') {
    if (raw === undefined || raw === null || raw === '') {
      if (enforceRequired && field.required) throw failure(`请填写「${field.label}」`, 422)
      return null
    }
    const value = Number(raw)
    if (!Number.isFinite(value)) throw failure(`「${field.label}」需要是数字`, 422)
    if (field.min !== undefined && value < field.min) throw failure(`「${field.label}」不能小于 ${field.min}`, 422)
    if (field.max !== undefined && value > field.max) throw failure(`「${field.label}」不能大于 ${field.max}`, 422)
    return value
  }
  const text = String(raw ?? '').trim()
  if (!text) {
    if (enforceRequired && field.required) throw failure(`请填写「${field.label}」`, 422)
    return ''
  }
  if (field.type === 'select') {
    if (!field.options.some(option => option.value === text)) throw failure(`「${field.label}」的取值不在可选范围内`, 422)
    return text
  }
  if (text.length > field.maxLength) throw failure(`「${field.label}」不能超过 ${field.maxLength} 个字符`, 422)
  return text
}

function defaultsOf(rules) {
  return Object.fromEntries(rules.map(field => {
    try { return [field.key, coerceConfigValue(field, field.default, false)] }
    catch { return [field.key, field.type === 'boolean' ? false : field.type === 'number' ? null : ''] }
  }))
}

function validateConfig(rules, input) {
  const source = input === undefined || input === null ? {} : input
  if (typeof source !== 'object' || Array.isArray(source)) throw failure('配置内容格式无效', 422)
  const allowed = new Set(rules.map(field => field.key))
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw failure(`配置项 ${key} 不在插件的声明里`, 422)
  return Object.fromEntries(rules.map(field => [
    field.key,
    coerceConfigValue(field, Object.hasOwn(source, field.key) ? source[field.key] : field.default, true),
  ]))
}


export function createNodePlugins({ workspaceFiles }: Record<string, any>) {
  async function readMeta(userId) {
    const entry = (await workspaceFiles.list(userId)).find(item => item.path === META_PATH)
    if (!entry) return []
    try {
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await workspaceFiles.read(userId, META_PATH)).bytes))
      if (!Array.isArray(data) || data.some(item => !validNodeName(item?.name))
        || new Set(data.map(item => item.name)).size !== data.length) throw new Error('Invalid plugin registry')
      return data
    } catch { throw failure('节点插件清单无法读取或格式无效，请检查后重试', 409) }
  }

  async function writeMeta(userId, list) {
    await workspaceFiles.upsert(userId, META_PATH, 'application/json', Buffer.from(JSON.stringify(list), 'utf8'))
  }

  function bundlePath(name) {
    return `nodes/${name}.umd.js`
  }

  // 版本优先取已装 bundle 头的构建标记，读不到再退回元数据里记的值。
  async function installedNodeVersion(plugin, userId) {
    try { return nodeBundleVersion(Buffer.from((await workspaceFiles.read(userId, bundlePath(plugin.name))).bytes).toString('utf8')) ?? plugin.version }
    catch { return plugin.version }
  }

  async function handle(request, response, session, url, helpers) {
    const { json, readJson, sameOrigin } = helpers
    const mutate = () => {
      sameOrigin(request)
      if (!isWorkspaceRequest(request.headers)) throw failure('请求被拒绝，请刷新页面后重试', 403)
    }

    if (url.pathname === '/api/nodes/get' && request.method === 'GET') {
      const plugins = (await readMeta(session.userId))
      json(response, 200, {
        code: 200,
        data: [
          ...BUILTIN_NODES.map(node => ({ ...node, url: `/api/nodes/files?name=${node.name}`, builtin: true })),
          ...plugins.map(plugin => ({
            name: plugin.name,
            displayName: plugin.displayName || plugin.name,
            url: `/api/nodes/files?name=${plugin.name}`,
            enabled: plugin.enabled !== false,
            config: plugin.config ?? {},
            configRules: Array.isArray(plugin.configRules) ? plugin.configRules : [],
            author: plugin.author || '',
            version: plugin.version || '',
            builtin: false,
          })),
        ],
      })
      return true
    }

    if (url.pathname === '/api/nodes/files' && request.method === 'GET') {
      const name = String(url.searchParams.get('name') || '')
      if (!validNodeName(name)) throw failure('节点名无效', 422)
      const builtin = BUILTIN_NODES.find(node => node.name === name)
      if (builtin) { json(response, 404, { error: '内置节点随工作台发布，没有独立脚本' }); return true }
      if (!(await readMeta(session.userId)).some(item => item.name === name)) throw failure('节点插件不存在', 404)
      const file = (await workspaceFiles.read(session.userId, bundlePath(name)))
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': file.bytes.length,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      })
      response.end(Buffer.from(file.bytes))
      return true
    }

    if (url.pathname === '/api/nodes/install' && request.method === 'POST') {
      return withPluginInstall(request, response, helpers, async ({ signal, assertCurrent }) => {
        mutate()
        const payload = await readJson(request, NODE_INSTALL_BODY_BYTES, signal)
        assertCurrent()
        // 本地安装传 bundle，从链接安装传 url；两种来源走同一套校验与版本判断。
        const remote = typeof payload.url === 'string' && payload.url.trim() ? assertPluginUrl(payload.url) : ''
        const name = validNodeName(payload.name) ? String(payload.name).trim() : nodeNameFromUrl(remote)
        if (!validNodeName(name)) throw failure('节点名必须是字母开头、仅含字母数字的小驼峰', 422)
        if (BUILTIN_NODES.some(node => node.name === name)) throw failure('不能覆盖内置节点', 422)
        const bundle = remote
          ? (await downloadPluginFile(remote, { limitBytes: MAX_PLUGIN_BYTES, label: '节点脚本', signal })).toString('utf8')
          : (typeof payload.bundle === 'string' ? payload.bundle : '')
        assertCurrent()
        validateNodeBundle(name, bundle)
        const declaration = parseConfigDeclaration(bundle)
        const version = String(nodeBundleVersion(bundle) ?? payload.version ?? '').trim()
        if (version.length > MAX_VERSION_LENGTH) throw failure(`插件版本号不能超过 ${MAX_VERSION_LENGTH} 个字符`, 422)
        // Publish the bundle and its settings together. Read the current list and
        // version under the same lock so concurrent updates cannot be overwritten.
        await workspaceFiles.withDeferredBytes(async () => {
          assertCurrent()
          const config = defaultsOf(declaration.rules)
          const list = (await readMeta(session.userId))
          const previous = list.find(item => item.name === name)
          if (previous && payload.force !== true) {
            requireNewerVersion((await installedNodeVersion(previous, session.userId)), version, `节点「${name}」`)
          }
          // 重装保留用户已经填过的值：只认仍在新声明里的字段，单个字段不合新规则就退回默认值。
          if (previous?.config && typeof previous.config === 'object') {
            for (const field of declaration.rules) {
              if (!Object.hasOwn(previous.config, field.key)) continue
              try { config[field.key] = coerceConfigValue(field, previous.config[field.key], true) } catch { /* 声明变了，保留默认值 */ }
            }
          }
          const next = list.filter(item => item.name !== name)
          next.push({
            name,
            displayName: String(payload.displayName || previous?.displayName || name).slice(0, 60),
            author: String(payload.author || previous?.author || '').slice(0, 60),
            version,
            enabled: previous?.enabled !== false,
            configRules: declaration.rules,
            config,
          })
          await workspaceFiles.upsert(session.userId, bundlePath(name), 'text/javascript', Buffer.from(bundle, 'utf8'))
          await writeMeta(session.userId, next)
        }, session.userId)
        json(response, 200, { code: 200, data: { name, installed: true, configFields: declaration.rules.length, droppedSecretFields: declaration.secretFields } })
        return true
      })
    }

    if (url.pathname === '/api/nodes/skill/install' && request.method === 'POST') {
      return withPluginInstall(request, response, helpers, async ({ signal, assertCurrent }) => {
        mutate()
        const payload = await readJson(request, SKILL_INSTALL_BODY_BYTES, signal)
        assertCurrent()
        // 技能包与节点一样支持本地文件（base64）与从链接下载两种来源。
        const remote = typeof payload.url === 'string' && payload.url.trim() ? assertPluginUrl(payload.url) : ''
        const fileName = String(payload.fileName || '').trim() || fileNameFromUrl(remote)
        const bytes = remote
          ? await downloadPluginFile(remote, { limitBytes: MAX_ARCHIVE_BYTES, label: '技能包', signal })
          : Buffer.from(typeof payload.content === 'string' ? payload.content : '', 'base64')
        assertCurrent()
        const installed = (await installSkillPackage({ workspaceFiles, userId: session.userId, fileName, bytes, force: payload.force === true }))
        json(response, 200, { code: 200, data: installed })
        return true
      })
    }

    if (url.pathname === '/api/nodes/config' && request.method === 'POST') {
      mutate()
      const payload = await readJson(request, CONFIG_BODY_BYTES)
      const name = String(payload?.name || '').trim()
      if (!validNodeName(name)) throw failure('节点名无效', 422)
      const config = (await workspaceFiles.withDeferredBytes(async () => {
        const list = (await readMeta(session.userId))
        const plugin = list.find(item => item.name === name)
        if (!plugin) throw failure('节点插件不存在', 404)
        const rules = Array.isArray(plugin.configRules) ? plugin.configRules : []
        if (!rules.length) throw failure('该插件没有声明配置项', 422)
        plugin.config = validateConfig(rules, payload?.config)
        await writeMeta(session.userId, list)
        return plugin.config
      }, session.userId))
      json(response, 200, { code: 200, data: { name, config } })
      return true
    }

    if (url.pathname === '/api/nodes/remove' && request.method === 'POST') {
      mutate()
      const payload = await readJson(request)
      const name = String(payload.name || '').trim()
      if (!validNodeName(name)) throw failure('节点名无效', 422)
      await workspaceFiles.withDeferredBytes(async () => {
        const list = (await readMeta(session.userId))
        if (!list.some(item => item.name === name)) throw failure('节点插件不存在', 404)
        await writeMeta(session.userId, list.filter(item => item.name !== name))
        const path = bundlePath(name)
        if ((await workspaceFiles.list(session.userId)).some(item => item.path === path)) {
          await workspaceFiles.mutate(session.userId, { operation: 'remove', path, revision: (await workspaceFiles.read(session.userId, path)).revision })
        }
      }, session.userId)
      json(response, 200, { code: 200, data: { name, removed: true } })
      return true
    }

    if (url.pathname === '/api/nodes/toggle' && request.method === 'POST') {
      mutate()
      const payload = await readJson(request)
      const name = String(payload.name || '').trim()
      const enabled = payload.enabled !== false
      await workspaceFiles.withDeferredBytes(async () => {
        const list = (await readMeta(session.userId))
        const plugin = list.find(item => item.name === name)
        if (!plugin) throw failure('节点插件不存在', 404)
        plugin.enabled = enabled
        await writeMeta(session.userId, list)
      }, session.userId)
      json(response, 200, { code: 200, data: { name, enabled } })
      return true
    }

    throw failure('节点接口不存在', 404)
  }

  return { handle }
}
