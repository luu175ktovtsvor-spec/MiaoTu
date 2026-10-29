import { mapAsync } from './async-collections.ts'
import { pluginExportNames, inspectPluginExports, readPluginMetadata } from './canvas-document.ts'
import { isWorkspaceRequest } from './canvas-document.ts'
// 文件扩展：MiaoImg 的 /api/ext/* 在妙图里的实现。
// 扩展是 UMD bundle（构建时把 vue / element-plus / @miaoimg/i18n/vue / tiptap 外置到
// window.miaoimgExtHost、window.miaoimgTiptapHost），bundle 头部的注释里带一份元数据；
// 安装后按账号存进工作区，文档面板按资源类型选扩展、按需加载脚本。
// 内置扩展随工作台发布（组件编译进前端），这里只登记元数据：只读、不可卸载、不可覆盖。
import { failure } from './management-store.ts'
import { MAX_PLUGIN_BYTES, MAX_VERSION_LENGTH, assertPluginUrl, downloadPluginFile, requireNewerVersion, withPluginInstall } from './plugin-install.ts'

const icon = (color, body) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`)}`

// 内置扩展的元数据只此一份：前端只按 id 提供组件，不重复声明后缀、图标与配置规则。
export const BUILTIN_EXTS = [
  {
    id: 'ext-md', displayName: 'Markdown', version: '1.0.0', text: true, resourceKind: 'file',
    extensions: ['md', 'markdown'],
    icon: icon('#7aa2f7', '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M5 16V8l4 4 4-4v8M18 8v8m-2-2 2 2 2-2"/>'),
  },
  {
    id: 'ext-txt', displayName: '文本编辑器', version: '1.0.0', text: true, resourceKind: 'file',
    extensions: ['txt', 'log', 'json', 'jsonc', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'toml', 'ini'],
    icon: icon('#4e9fff', '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>'),
    configRules: [
      { type: 'inputNumber', field: 'fontSize', title: '字号', value: 14, props: { min: 10, max: 32, step: 1 } },
      { type: 'switch', field: 'wordWrap', title: '自动换行', value: true },
    ],
  },
  {
    id: 'ext-image', displayName: '图片', version: '1.0.0', resourceKind: 'file',
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico'],
    icon: icon('#41b883', '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-5-5L5 21"/>'),
    configRules: [{ type: 'switch', field: 'fitToWindow', title: '图片适应窗口', value: true }],
  },
  {
    id: 'ext-media', displayName: '音视频', version: '1.0.0', resourceKind: 'file',
    extensions: ['mp4', 'mp3', 'wav', 'pcm', 'opus'],
    icon: icon('#4e9fff', '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4z"/>'),
  },
  {
    id: 'ext-canvasNode', displayName: '画布节点', version: '1.0.0', resourceKind: 'canvasNode', extensions: [],
    icon: icon('#a78bfa', '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  },
]

const META_PATH = 'ext/plugins.json'
const STATE_PATH = 'ext/state.json'
const CONFIG_PATH = 'ext/configs.json'
// bundle 是文本，走 JSON 传输；20MB 成品的 base64 也装得下。
const INSTALL_BODY_BYTES = 30 * 1024 * 1024
const CONFIG_BODY_BYTES = 512 * 1024
const MAX_CONFIG_RULES = 100
const MAX_CONFIG_BYTES = 64 * 1024
const EXT_NAME = /^ext-[a-z][a-zA-Z0-9]*$/
const SUFFIX = /^[a-z0-9]+$/
const RESOURCE_KINDS = ['file', 'canvasNode']

export function validExtName(value) {
  const name = String(value || '')
  return name.length <= 96 && EXT_NAME.test(name)
}

function validIcon(value) {
  if (value === undefined || value === '') return true
  if (typeof value !== 'string') return false
  if (/^data:image\/(?:svg\+xml|png|jpeg|webp|gif|avif)(?:;[^,]*)?,/i.test(value)) return true
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

// 元数据必须能被 JSON 往返：扩展声明里不允许出现函数与循环引用。
function plainJson(value, label) {
  let text
  try { text = JSON.stringify(value) } catch { throw failure(`${label}必须是可序列化的 JSON`, 422) }
  if (text === undefined) throw failure(`${label}必须是可序列化的 JSON`, 422)
  return JSON.parse(text)
}

function normalizeRules(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_CONFIG_RULES) throw failure(`扩展配置规则必须为最多 ${MAX_CONFIG_RULES} 项的表单规则数组`, 422)
  const rules = plainJson(value, '扩展配置规则')
  if (rules.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw failure('扩展配置规则必须为最多 100 项的表单规则数组', 422)
  if (Buffer.byteLength(JSON.stringify(rules), 'utf8') > MAX_CONFIG_BYTES) throw failure('扩展配置规则过大', 422)
  return rules
}

function normalizeMetadata(raw, name) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!source) throw failure('文件扩展元数据无效', 400)
  const id = String(source.id || '')
  if (!validExtName(id) || id !== name) throw failure('文件扩展元数据无效，请使用扩展脚手架重新构建，且文件名必须与扩展 ID 一致', 400)
  const displayName = String(source.displayName || '').trim()
  if (!displayName) throw failure('文件扩展缺少显示名', 400)
  const resourceKind = String(source.resourceKind || '')
  if (!RESOURCE_KINDS.includes(resourceKind)) throw failure('扩展资源类型无效', 400)
  const extensions = source.extensions
  if (!Array.isArray(extensions) || extensions.some(item => typeof item !== 'string' || !SUFFIX.test(item))) {
    throw failure('文件后缀必须是不带点的小写字母或数字', 400)
  }
  if (new Set(extensions).size !== extensions.length) throw failure('文件后缀不能重复', 400)
  if (resourceKind === 'file' && !extensions.length) throw failure('文件扩展至少需要一个后缀', 400)
  if (!validIcon(source.icon)) throw failure('扩展图标必须是 HTTP、HTTPS 或图片 data URL', 400)
  const version = String(source.version || '').trim()
  if (!version) throw failure('文件扩展元数据缺少版本号', 400)
  if (version.length > MAX_VERSION_LENGTH) throw failure(`插件版本号不能超过 ${MAX_VERSION_LENGTH} 个字符`, 422)
  if (source.text !== undefined && typeof source.text !== 'boolean') throw failure('扩展文本标记必须为布尔值', 400)
  return {
    id,
    displayName: displayName.slice(0, 60),
    icon: typeof source.icon === 'string' ? source.icon : '',
    extensions,
    resourceKind,
    text: source.text === true,
    version,
    readme: String(source.readme || '').slice(0, 200_000),
    author: String(source.author || '').slice(0, 60),
    configRules: normalizeRules(source.configRules),
  }
}

// 元数据写在 bundle 头部的注释里，安装时静态提取，不执行脚本。
export function parseExt(source, name) {
  if (!validExtName(name)) throw failure('扩展名必须是 ext- 加小驼峰名称，最多 96 个字符', 422)
  let raw
  try { raw = readPluginMetadata(String(source || ''), 'extension'); if (!raw) throw new Error('Missing metadata') } catch {
    throw failure('文件扩展元数据无效，请使用扩展脚手架重新构建，且文件名必须与扩展 ID 一致', 400)
  }
  return normalizeMetadata(raw, name)
}

function validateBundle(source, name) {
  const text = String(source || '')
  if (!text.trim()) throw failure('扩展脚本不能为空', 422)
  if (Buffer.byteLength(text, 'utf8') > MAX_PLUGIN_BYTES) throw failure('文件扩展不能超过 20 MB', 413)
  if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text)) throw failure('这个文件是网页而不是扩展脚本，请上传构建生成的 .umd.js', 422)
  if (!pluginExportNames('extension').some(name => text.includes(name))) throw failure('这个文件不是文件扩展，请上传构建生成的 .umd.js', 422)
  // 只在能确凿读出导出名时才比对，按变量导出（miaoimgExts[id]）的 bundle 交给加载时报错兜底。
  const exported = inspectPluginExports(text, 'extension')
  if (exported.length && !exported.includes(name)) {
    throw failure(`文件里导出的是扩展「${exported[0]}」，与扩展 ID「${name}」不一致，请改成一致的名称`, 422)
  }
  return text
}

function extNameFromUrl(rawUrl) {
  if (!rawUrl) return ''
  try { return (decodeURIComponent(new URL(rawUrl).pathname).split('/').pop() || '').replace(/\.umd\.js$/i, '').slice(0, 128) } catch { return '' }
}

// ---- 配置规则 ----

// 规则可能嵌在容器里（布局 children、条件 control[].rule），保存与读取都要一路收全。
function configFields(rules) {
  const fields = []
  const walk = (list) => {
    for (const rule of list) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue
      if (typeof rule.field === 'string' && rule.field) fields.push(rule)
      if (Array.isArray(rule.children)) walk(rule.children)
      if (Array.isArray(rule.control)) for (const item of rule.control) if (Array.isArray(item?.rule)) walk(item.rule)
    }
  }
  walk(Array.isArray(rules) ? rules : [])
  return fields
}

function fieldProps(rule) {
  return rule.props && typeof rule.props === 'object' && !Array.isArray(rule.props) ? rule.props : {}
}

function declaredConfig(rules, saved) {
  const config = {}
  for (const rule of configFields(rules)) {
    const props = fieldProps(rule)
    const fallback = Object.hasOwn(props, 'defaultValue') ? props.defaultValue : rule.value
    config[rule.field] = Object.hasOwn(saved, rule.field) ? saved[rule.field] : fallback
  }
  return config
}

// 配置会随 /api/ext/list 下发到浏览器，只接受规则里声明过的字段，并按控件类型收敛取值。
function validateExtConfig(rules, input) {
  const source = input === undefined || input === null ? {} : input
  if (typeof source !== 'object' || Array.isArray(source)) throw failure('扩展配置必须是对象', 422)
  const fields = configFields(rules)
  const allowed = new Set(fields.map(rule => rule.field))
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw failure(`配置项 ${key} 不在扩展的声明里`, 422)
  const config = declaredConfig(rules, source)
  for (const rule of fields) {
    if (!Object.hasOwn(config, rule.field)) continue
    const value = config[rule.field]
    const props = fieldProps(rule)
    if (value === undefined || value === null) continue
    if (rule.type === 'inputNumber') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw failure(`「${rule.title || rule.field}」必须是数字`, 422)
      if (typeof props.min === 'number' && value < props.min) throw failure(`「${rule.title || rule.field}」不能小于 ${props.min}`, 422)
      if (typeof props.max === 'number' && value > props.max) throw failure(`「${rule.title || rule.field}」不能大于 ${props.max}`, 422)
    } else if (rule.type === 'switch' && typeof value !== 'boolean') {
      throw failure(`「${rule.title || rule.field}」必须是开关值`, 422)
    }
  }
  const serialized = JSON.stringify(config)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) throw failure('扩展配置过大', 413)
  return JSON.parse(serialized)
}

// ---- 工作区存储 ----

export function createExtPlugins({ workspaceFiles }: Record<string, any>) {
  const invalidSettings = path => failure(`${path === META_PATH ? '文件扩展清单' : path === STATE_PATH ? '扩展启停设置' : '扩展配置'}无法读取或格式无效，请检查后重试`, 409)

  async function readJsonFile(userId, path, fallback) {
    if (!(await workspaceFiles.list(userId)).some(item => item.path === path)) return fallback
    try {
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await workspaceFiles.read(userId, path)).bytes))
      if (!data || typeof data !== 'object' || Array.isArray(data) !== Array.isArray(fallback)) throw new Error('Invalid plugin settings')
      return data
    } catch { throw invalidSettings(path) }
  }

  async function writeJsonFile(userId, path, value) {
    await workspaceFiles.upsert(userId, path, 'application/json', Buffer.from(JSON.stringify(value), 'utf8'))
  }

  const readMeta = async (userId) => {
    const list = (await readJsonFile(userId, META_PATH, []))
    if (list.some(item => !validExtName(item?.name)) || new Set(list.map(item => item.name)).size !== list.length) throw invalidSettings(META_PATH)
    return list
  }
  const writeMeta = async (userId, list) => (await writeJsonFile(userId, META_PATH, list))
  const readState = async (userId) => {
    const state = (await readJsonFile(userId, STATE_PATH, {}))
    if (state.disabled === undefined) return []
    if (!Array.isArray(state.disabled) || state.disabled.some(item => !validExtName(item))) throw invalidSettings(STATE_PATH)
    return state.disabled
  }
  const readConfigs = async (userId) => (await readJsonFile(userId, CONFIG_PATH, {}))

  const bundlePath = (name) => `ext/${name}.umd.js`
  const builtinOf = (name) => BUILTIN_EXTS.find(item => item.id === name)

  // 用户扩展的配置声明只写在 bundle 头部，清单里不重复存；读不到就当作没有配置项。
  async function rulesOf(userId, name) {
    const builtin = builtinOf(name)
    if (builtin) return builtin.configRules || []
    if (!(await readMeta(userId)).some(item => item.name === name)) return undefined
    try { return parseExt(Buffer.from((await workspaceFiles.read(userId, bundlePath(name))).bytes).toString('utf8'), name).configRules }
    catch { return [] }
  }

  // 版本优先取已装 bundle 头的构建标记，读不到再退回清单里记的值。
  async function installedVersion(plugin, userId) {
    try { return parseExt(Buffer.from((await workspaceFiles.read(userId, bundlePath(plugin.name))).bytes).toString('utf8'), plugin.name).version ?? plugin.version }
    catch { return plugin.version }
  }

  // 清单里每一项的元数据都以 bundle 头部为准，bundle 读不出来就带着 loadError 出现，
  // 让插件市场能把这一项显示成坏的，而不是让整个列表失败。
  async function entryOf(plugin, userId, disabled, configs) {
    let launch
    try { launch = parseExt(Buffer.from((await workspaceFiles.read(userId, bundlePath(plugin.name))).bytes).toString('utf8'), plugin.name) }
    catch (error) { launch = { loadError: error?.message || '文件扩展无法读取' } }
    const rules = Array.isArray(launch.configRules) ? launch.configRules : []
    return {
      ...launch,
      name: plugin.name,
      id: plugin.name,
      displayName: launch.displayName || plugin.displayName || plugin.name,
      author: plugin.author || '',
      version: launch.version || plugin.version || '',
      configRules: rules,
      config: declaredConfig(rules, configs[plugin.name] || {}),
      enabled: !disabled.includes(plugin.name),
      builtin: false,
      url: `/api/ext/read?name=${plugin.name}`,
    }
  }

  function builtinEntry(extension, disabled, configs) {
    const rules = extension.configRules || []
    return {
      ...extension,
      name: extension.id,
      author: '',
      readme: '',
      configRules: rules,
      config: declaredConfig(rules, configs[extension.id] || {}),
      enabled: !disabled.includes(extension.id),
      builtin: true,
      url: '',
    }
  }

  async function handle(request, response, session, url, helpers) {
    const { json, readJson, sameOrigin } = helpers
    // 安装、卸载、启停都会改账号工作区，和节点插件一样要求同源 + 工作区标记。
    const mutate = () => {
      sameOrigin(request)
      if (!isWorkspaceRequest(request.headers)) throw failure('请求被拒绝，请刷新页面后重试', 403)
    }

    if (url.pathname === '/api/ext/list' && request.method === 'GET') {
      const disabled = (await readState(session.userId))
      // 配置一次读出来，逐项组装时不再重复查库。
      const configs = (await readConfigs(session.userId))
      const extensions = [
        ...BUILTIN_EXTS.map(extension => builtinEntry(extension, disabled, configs)),
        ...(await mapAsync((await readMeta(session.userId)), async plugin => (await entryOf(plugin, session.userId, disabled, configs)))),
      ].sort((left, right) => left.id.localeCompare(right.id))
      json(response, 200, { code: 200, data: extensions })
      return true
    }

    if (url.pathname === '/api/ext/read' && request.method === 'GET') {
      const name = String(url.searchParams.get('name') || '')
      if (!validExtName(name)) throw failure('扩展名无效', 422)
      if (builtinOf(name)) { json(response, 404, { error: '内置扩展随工作台发布，没有独立脚本' }); return true }
      if (!(await readMeta(session.userId)).some(item => item.name === name)) throw failure('文件扩展不存在', 404)
      if ((await readState(session.userId)).includes(name)) throw failure('文件扩展已停用', 404)
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

    if (url.pathname === '/api/ext/install' && request.method === 'POST') {
      return withPluginInstall(request, response, helpers, async ({ signal, assertCurrent }) => {
        mutate()
        const payload = await readJson(request, INSTALL_BODY_BYTES, signal)
        assertCurrent()
        // 本地安装传 bundle，从链接安装传 url；两种来源走同一套校验与版本判断。
        const remote = typeof payload.url === 'string' && payload.url.trim() ? assertPluginUrl(payload.url) : ''
        const bundle = remote
          ? (await downloadPluginFile(remote, { limitBytes: MAX_PLUGIN_BYTES, label: '扩展脚本', signal })).toString('utf8')
          : (typeof payload.bundle === 'string' ? payload.bundle : typeof payload.source === 'string' ? payload.source : '')
        assertCurrent()
        const requested = String(payload.name || '').trim()
        if (requested && !validExtName(requested)) throw failure('扩展名必须是 ext- 加小驼峰名称，最多 96 个字符', 422)
        // 没传名字时先看链接里的文件名，再看 bundle 声明里的 ID。
        const name = requested || (validExtName(extNameFromUrl(remote)) ? extNameFromUrl(remote) : (() => {
          try { return String((readPluginMetadata(bundle, 'extension') as { id?: unknown })?.id || '') } catch { return '' }
        })())
        if (!validExtName(name)) throw failure('扩展名必须是 ext- 加小驼峰名称，最多 96 个字符', 422)
        if (builtinOf(name)) throw failure('不能覆盖内置扩展', 422)
        validateBundle(bundle, name)
        const metadata = parseExt(bundle, name)
        // The installed version, shared list and saved configuration must all
        // belong to the same commit as the bundle.
        await workspaceFiles.withDeferredBytes(async () => {
          assertCurrent()
          const list = (await readMeta(session.userId))
          const previous = list.find(item => item.name === name)
          if (previous && payload.force !== true) requireNewerVersion((await installedVersion(previous, session.userId)), metadata.version, `文件扩展「${name}」`)
          await workspaceFiles.upsert(session.userId, bundlePath(name), 'text/javascript', Buffer.from(bundle, 'utf8'))
          // 重装保留用户已经填过的值：只认仍在新声明里的字段，不合新规则就退回默认值。
          const next = list.filter(item => item.name !== name)
          next.push({
            name,
            displayName: metadata.displayName,
            author: String(payload.author || previous?.author || '').slice(0, 60),
            version: metadata.version,
          })
          await writeMeta(session.userId, next)
          const configs = (await readConfigs(session.userId))
          const saved = configs[name] && typeof configs[name] === 'object' ? configs[name] : {}
          let config
          try { config = validateExtConfig(metadata.configRules, saved) }
          catch { config = declaredConfig(metadata.configRules, {}) }
          configs[name] = config
          await writeJsonFile(session.userId, CONFIG_PATH, configs)
        }, session.userId)
        json(response, 200, { code: 200, data: { name, installed: true, version: metadata.version, configFields: configFields(metadata.configRules).length } })
        return true
      })
    }

    if (url.pathname === '/api/ext/save' && ['POST', 'PUT'].includes(request.method)) {
      mutate()
      const payload = await readJson(request, CONFIG_BODY_BYTES)
      const name = String(payload?.name || '').trim()
      if (!validExtName(name)) throw failure('扩展名无效', 422)
      const config = (await workspaceFiles.withDeferredBytes(async () => {
        const rules = (await rulesOf(session.userId, name))
        if (!rules) throw failure('文件扩展不存在', 404)
        if (!configFields(rules).length) throw failure('该扩展没有声明配置项', 422)
        const config = validateExtConfig(rules, payload?.config)
        const configs = (await readConfigs(session.userId))
        configs[name] = config
        await writeJsonFile(session.userId, CONFIG_PATH, configs)
        return config
      }, session.userId))
      json(response, 200, { code: 200, data: { name, config } })
      return true
    }

    if (url.pathname === '/api/ext/setEnabled' && ['POST', 'PUT'].includes(request.method)) {
      mutate()
      const payload = await readJson(request)
      const name = String(payload?.name || '').trim()
      if (!validExtName(name)) throw failure('扩展名无效', 422)
      const enabled = payload.enabled !== false
      await workspaceFiles.withDeferredBytes(async () => {
        if (!builtinOf(name) && !(await readMeta(session.userId)).some(item => item.name === name)) throw failure('文件扩展不存在', 404)
        const disabled = new Set((await readState(session.userId)))
        if (enabled) disabled.delete(name)
        else disabled.add(name)
        await writeJsonFile(session.userId, STATE_PATH, { disabled: [...disabled] })
      }, session.userId)
      json(response, 200, { code: 200, data: { name, enabled } })
      return true
    }

    if (url.pathname === '/api/ext/uninstall' && ['POST', 'DELETE'].includes(request.method)) {
      mutate()
      const payload = await readJson(request)
      const name = String(payload?.name || '').trim()
      if (!validExtName(name)) throw failure('扩展名无效', 422)
      if (builtinOf(name)) throw failure('内置扩展随工作台发布，不能卸载', 422)
      await workspaceFiles.withDeferredBytes(async () => {
        const list = (await readMeta(session.userId))
        if (!list.some(item => item.name === name)) throw failure('文件扩展不存在', 404)
        await writeMeta(session.userId, list.filter(item => item.name !== name))
        const path = bundlePath(name)
        if ((await workspaceFiles.list(session.userId)).some(item => item.path === path)) {
          await workspaceFiles.mutate(session.userId, { operation: 'remove', path, revision: (await workspaceFiles.read(session.userId, path)).revision })
        }
        const configs = (await readConfigs(session.userId))
        delete configs[name]
        await writeJsonFile(session.userId, CONFIG_PATH, configs)
        const disabled = (await readState(session.userId)).filter(item => item !== name)
        await writeJsonFile(session.userId, STATE_PATH, { disabled })
      }, session.userId)
      json(response, 200, { code: 200, data: { name, removed: true } })
      return true
    }

    throw failure('文件扩展接口不存在', 404)
  }

  return { handle }
}
