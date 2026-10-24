import { toolWorkspaceFiles } from './tool-workspace-files.ts'
// Agent（server/agent-api.ts）与 MCP（server/mcp-api.ts）共用的服务端工具实现。
// 与 server/media-tools.ts 同一套做法：定义只写一次，两边各自注入 userId/signal。
//   - 网页：webFetch / webSearch（公网读取、正文提取与官方 MCP 搜索）
//   - 技能：listSkills / readSkill（工作区 skills/<名称>/ + 随产品发布的内置技能）
//   - 工作区文件：list / read / write 三个核心动作，Agent 的 listWorkspaceFiles /
//     readWorkspaceFile / writeWorkspaceFile 与 MCP 的 workspaceFiles 都调它，
//     避免同一件事出现两套上限与两套报错。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { failure } from './management-store.ts'
import { createWebTools, WEB_TOOLS } from './web/tools.ts'
import { parseFrontmatter } from '@earendil-works/pi-coding-agent'
import { SKILL_NAME_PATTERN, SKILL_NAME_SCHEMA } from './skill-names.ts'
import { isProtectedWorkspacePath } from './workspace-path.ts'
import { readWorkspaceRange } from './workspace-read.ts'
export { isProtectedWorkspacePath } from './workspace-path.ts'

// ---- 技能 ----
// 账号工作区里的 skills/<name>/SKILL.md；Agent 消息里出现 /skill:<name> 时注入内容。
const SKILLS_DIR = 'skills'
const MAX_SKILL_BYTES = 200 * 1024
// 随产品发布的内置技能（对应上游 packages/skills）：所有账号可用，只读。
const BUILTIN_SKILLS_DIR = fileURLToPath(new URL('./builtin-skills/', import.meta.url))
// 内置技能按创作板块分成 8 个；每个方法的正文完整放在所属板块的 references 下。
// 方法 ID 和旧 ID 都在这里登记，readSkill 用它们找到正文；值为字符串时目录是 references/<ID>，
// 值为 [ID, 目录] 时用给定目录（短剧漫剧全流程把作者的整套技能放在 references/suite/ 下，保持原有的相对路径）。
const DRAMA_SUITE = ['short-drama-director', 'sd-decision-engine', 'sd-recon-engine', 'sd-script-engine', 'sd-overseas-engine', 'sd-jieshuo-engine', 'sd-asset-engine', 'sd-storyboard-engine', 'sd-combat-engine', 'sd-xuanhuan-engine', 'sd-real-engine', 'sd-feed-engine', 'sd-qc-engine']
const BUILTIN_SKILL_GROUPS: Record<string, Array<string | [string, string]>> = {
  'canvas': ['workflow'],
  'script-writing': ['miaotu-film-screenwriting', 'miaotu-original-screenplay-adaptation', 'miaotu-film-script-analysis', 'short-drama-factory'],
  'asset-design': ['miaotu-character-turnaround', 'miaotu-character-orthographic', 'miaotu-character-expression', 'miaotu-character-pose', 'miaotu-character-costume', 'miaotu-character-prop', 'miaotu-script-asset-dna', 'miaotu-scene-turnaround', 'miaotu-scene-top-view-layout', 'miaotu-ai-drama-scene-layout', 'miaotu-vr-panorama', 'miaotu-giant-scale-scene'],
  'storyboard': ['miaotu-script-to-video', 'miaotu-90s-script-to-video', 'miaotu-storyboard-panel', 'miaotu-visual-storyboard-grid'],
  // 套装里的写实、玄幻打戏引擎取代了作者早先单独发布的两个动作导演；旧 ID 指向套装里的对应引擎。
  'drama-director': [...DRAMA_SUITE.map(name => [name, `references/suite/${name}`] as [string, string]), ['real-combat-director', 'references/suite/sd-real-engine'], ['xuanhuan-combat-director', 'references/suite/sd-xuanhuan-engine']],
  'video-create': ['video-remake', 'video-plan', 'video-script', 'video-direction', 'video-performance', 'video-broll', 'video-sound', 'video-captions', 'video-graphics', 'video-review', 'video-continuity', 'video-talking-head', 'video-interview', 'video-podcast', 'video-explainer', 'video-ranking', 'video-short-drama'],
  'video-analysis': ['miaotu-video-shot-analysis'],
  'image-direction': ['visual-direction', 'inspiration-library'],
}
const BUILTIN_SKILL_ALIASES = new Map(Object.entries(BUILTIN_SKILL_GROUPS).flatMap(([skill, methods]) => methods.map(method => {
  const [id, base] = typeof method === 'string' ? [method, `references/${method}`] : method
  return [id, { skill, base }] as const
})))
// 内置目录随镜像发布，元数据只读一次；账号自定义技能仍读取当前项目索引。
let builtinCatalog

function builtinSkillNames() {
  try {
    return readdirSync(BUILTIN_SKILLS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => SKILL_NAME_PATTERN.test(name) && existsSync(join(BUILTIN_SKILLS_DIR, name, 'SKILL.md')))
      .sort((left, right) => left.localeCompare(right))
  } catch { return [] }
}

function builtinSkillText(name, relativePath = 'SKILL.md') {
  if (!SKILL_NAME_PATTERN.test(String(name || ''))) return null
  const alias = BUILTIN_SKILL_ALIASES.get(name)
  if (alias) { name = alias.skill; relativePath = `${alias.base}/${relativePath || 'SKILL.md'}` }
  const parts = skillReferenceParts(relativePath)
  if (!parts.length) return null
  const file = resolve(BUILTIN_SKILLS_DIR, name, ...parts)
  if (file !== resolve(BUILTIN_SKILLS_DIR, name) && !file.startsWith(resolve(BUILTIN_SKILLS_DIR, name) + sep)) return null
  try { return readFileSync(file, 'utf8') } catch { return null }
}

function skillReferenceParts(relativePath) {
  const relative = String(relativePath || 'SKILL.md')
  const parts = relative.split(/[\\/]+/)
  if (/^[\\/]|^[A-Za-z]:/.test(relative) || relative.includes('\0') || parts.some(part => part === '..')) {
    throw failure('技能引用必须是技能目录内的相对路径', 422)
  }
  return parts.filter(part => part && part !== '.')
}

function skillId(name) {
  const value = String(name || '').trim()
  if (!SKILL_NAME_PATTERN.test(value)) throw failure('技能名称须为 1–64 个字符，以字母或数字开头，其后仅支持字母、数字、点、下划线和短横线', 422)
  return value
}

function skillPath(name) { return `${SKILLS_DIR}/${skillId(name)}/SKILL.md` }

function parseSkill(name, text) {
  const meta: Record<string, any> = { name, description: '' }
  try {
    const { frontmatter } = parseFrontmatter(text)
    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === 'disable-model-invocation' && value === true) meta.manualOnly = true
      if (typeof value !== 'string' || !value.trim()) continue
      if (key === 'description') meta.description = value.slice(0, 1024)
      if (key === 'name') meta.name = value.slice(0, 64)
      if (key === 'displayName') meta.displayName = value.slice(0, 64)
      if (key === 'displayName_en') meta.displayNameEn = value.slice(0, 64)
      if (key === 'description_en') meta.descriptionEn = value.slice(0, 1024)
    }
  } catch { /* An invalid frontmatter still permits reading the original file. */ }
  const heading = text.split('\n').find(line => line.startsWith('# '))
  if (!meta.displayName && heading) meta.displayName = heading.slice(2).trim().slice(0, 60)
  if (!meta.description && heading) meta.description = heading.slice(2).trim().slice(0, 200)
  return meta
}

// 技能标签不写进前端词典：随技能文件保存在 frontmatter 里，服务端一次给中英两份，
// 由客户端按当前界面语言挑选（见 desktop/renderer/src/studio/canvas/i18n 的 translate 规则）。
function skillLabels(meta) {
  return {
    ...(meta.displayName ? { displayName: meta.displayName } : {}),
    ...(meta.displayNameEn ? { displayNameEn: meta.displayNameEn } : {}),
    ...(meta.descriptionEn ? { descriptionEn: meta.descriptionEn } : {}),
    ...(meta.manualOnly ? { manualOnly: true } : {}),
  }
}

/** 技能读写：工作区优先，内置技能只读兜底。 */
export function createSkillStore({ workspaceFiles, localSkills }: Record<string, any>) {
  function workspaceEntry(userId, path) {
    try { return workspaceFiles.stat(userId, path) }
    catch (error) { if (error?.status === 404) return null; throw error }
  }

  function skillEntry(userId, path, knownEntry?: any) {
    const entry = knownEntry || workspaceEntry(userId, path)
    if (!entry) return null
    const text = Buffer.from(workspaceFiles.read(userId, path).bytes).toString('utf8').slice(0, MAX_SKILL_BYTES)
    const name = path.split('/')[1]
    const meta = parseSkill(name, text)
    return { name: meta.name, id: name, ...skillLabels(meta), description: meta.description, size: entry.size || text.length }
  }

  function builtinEntry(name) {
    const text = builtinSkillText(name) || ''
    const meta = parseSkill(name, text)
    return { name: meta.name, id: name, ...skillLabels(meta), description: meta.description, size: Buffer.byteLength(text, 'utf8'), builtin: true }
  }

  function skillPreferences(userId) {
    const path = 'settings/skills.json'
    if (!workspaceEntry(userId, path)) return {}
    try {
      const preferences = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(workspaceFiles.read(userId, path).bytes))
      if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)
        || Object.entries(preferences).some(([name, enabled]) => !SKILL_NAME_PATTERN.test(name) || typeof enabled !== 'boolean')) throw new Error('Invalid skill preferences')
      return preferences
    } catch { throw failure('技能启停设置损坏或无法读取，请先修复 settings/skills.json', 409) }
  }
  function setSkillEnabled(userId, name, enabled) {
    name = skillId(name)
    if (typeof enabled !== 'boolean') throw failure('技能开关无效', 422)
    workspaceFiles.withDeferredBytes(() => {
      // 验证目标仍然可读，复用本地提供者的归属与权限检查；不为一个开关重扫所有正文。
      if (!skillEntry(userId, skillPath(name))) {
        if (localSkills && /^local-(home|project)-[a-f0-9]{20}$/.test(name)) localSkills.read(name, ['SKILL.md'])
        else if (builtinSkillText(name) === null) throw failure('技能不存在', 404)
      }
      const preferences = skillPreferences(userId)
      preferences[name] = enabled
      workspaceFiles.upsert(userId, 'settings/skills.json', 'application/json', Buffer.from(JSON.stringify(preferences)))
    })
    return { id: name, enabled }
  }
  function listSkills(userId, includeDisabled = false) {
    const userSkills = workspaceFiles.listSkillFiles(userId)
      .map(entry => skillEntry(userId, entry.path, entry))
      .filter(Boolean)
    const names = new Set(userSkills.map(skill => skill.id))
    builtinCatalog ||= Object.freeze(builtinSkillNames().map(name => Object.freeze(builtinEntry(name))))
    const builtins = builtinCatalog.filter(skill => !names.has(skill.id))
    const preferences = skillPreferences(userId)
    const locals = (localSkills?.list() || []).filter(skill => !names.has(skill.id)).map(skill => {
      const meta = parseSkill(skill.name, skill.bytes.toString('utf8'))
      return { id: skill.id, name: meta.name, ...skillLabels(meta), description: meta.description, size: skill.size, local: true, source: skill.scope === 'project' ? 'local-project' : 'local-home', location: skill.path }
    })
    return [...builtins, ...userSkills, ...locals].map(skill => ({ ...skill, enabled: preferences[skill.id] !== false })).filter(skill => includeDisabled || skill.enabled).sort((left, right) => left.id.localeCompare(right.id))
  }

  function readSkill(userId, name, relativePath = 'SKILL.md') {
    name = skillId(name)
    const relative = String(relativePath || 'SKILL.md')
    const parts = skillReferenceParts(relative)
    const path = skillPath(name)
    const preferences = skillPreferences(userId)
    // 停用的技能不再列出，入口也不能读取。内置板块之间共享的参考文件（例如拉片、图片指导引用的视频方法）
    // 不随所在板块一起停用，否则停用一个板块会让其他已启用板块读不到正文。
    const section = BUILTIN_SKILL_ALIASES.get(name)?.skill
    const builtin = Boolean(section) || builtinSkillNames().includes(name)
    if ((preferences[name] === false || preferences[section || ''] === false) && (relative === 'SKILL.md' || !builtin)) throw failure('技能已停用，请先在技能设置中启用', 403)
    const entry = workspaceEntry(userId, path)
    if (entry) {
      if (relative === 'SKILL.md') return workspaceFiles.read(userId, path)
      const referencePath = `${SKILLS_DIR}/${name}/${parts.join('/')}`
      if (workspaceEntry(userId, referencePath)) return workspaceFiles.read(userId, referencePath)
    }
    if (localSkills && /^local-(home|project)-[a-f0-9]{20}$/.test(name)) return localSkills.read(name, parts)
    const text = builtinSkillText(name, relative)
    if (text === null) throw failure('技能不存在', 404)
    return { path: `builtin:${name}/${relative}`, mime: 'text/markdown', bytes: Buffer.from(text, 'utf8'), revision: 'builtin' }
  }

  function writeSkill(userId, name, content, options: Record<string, any> = {}) {
    name = skillId(name)
    const path = skillPath(name)
    if (localSkills && /^local-(home|project)-[a-f0-9]{20}$/.test(name)) throw failure('本地技能请在原文件中修改，或另存为新的工作区技能', 403)
    const text = String(content ?? '')
    if (!text.trim()) throw failure('技能内容不能为空', 422)
    if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) throw failure('技能内容不能超过 200KB', 413)
    // Current editors and Agent calls use the workspace's existing atomic
    // revision check. Calls without a revision retain the older overwrite API.
    const revision = Object.hasOwn(options, 'revision')
      ? workspaceFiles.mutate(userId, { path, operation: 'write', encoding: 'text', mime: 'text/markdown', content: text, revision: options.revision }).revision
      : workspaceFiles.upsert(userId, path, 'text/markdown', Buffer.from(text, 'utf8'))
    return { ...skillEntry(userId, path), revision }
  }

  function removeSkill(userId, name) {
    name = skillId(name)
    const path = skillPath(name)
    if (localSkills && /^local-(home|project)-[a-f0-9]{20}$/.test(name)) throw failure('本地技能不能在这里删除，可以在技能设置中停用', 403)
    const entry = workspaceEntry(userId, path)
    if (!entry) {
      if (builtinSkillText(name) !== null) throw failure('内置技能不能删除，可以复制内容后另存为自己的技能', 403)
      throw failure('技能不存在', 404)
    }
    workspaceFiles.removeTree(userId, path.slice(0, path.lastIndexOf('/')), undefined, { path, revision: entry.revision })
    return { name }
  }

  return { listSkills, readSkill, writeSkill, removeSkill, setSkillEnabled }
}

// ---- 工作区文件 ----
// Agent 的三个工具与 MCP 的 workspaceFiles 都走这里，上限与报错只维护一份。
export function createWorkspaceFilesCore({ workspaceFiles }: Record<string, any>) {
  workspaceFiles = toolWorkspaceFiles(workspaceFiles).files
  return {
    list(userId, args: Record<string, any> = {}) {
      const prefix = String(args.pathPrefix ?? args.path ?? '')
      const limit = Math.floor(Math.min(500, Math.max(1, Number(args.limit) || 200)))
      const offset = Number(args.offset ?? 0)
      if (!Number.isSafeInteger(offset) || offset < 0) throw failure('列表偏移必须是非负整数', 422)
      const all = workspaceFiles.list(userId).filter(entry => !isProtectedWorkspacePath(entry.path) && (!prefix || entry.path.startsWith(prefix)))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      const entries = all.slice(offset, offset + limit)
      const nextOffset = offset + entries.length < all.length ? offset + entries.length : null
      return { entries, offset, total: all.length, hasMore: nextOffset !== null, nextOffset }
    },
    read(userId, args: Record<string, any> = {}) {
      const path = String(args.path || '')
      if (isProtectedWorkspacePath(path)) throw failure('该文件包含供应商密钥，Agent 不能读取', 403)
      const file = workspaceFiles.locate(userId, path)
      const maxBytes = Math.floor(Math.min(200_000, Math.max(1_000, Number(args.maxBytes) || 100_000)))
      const offset = Number(args.offset ?? 0)
      const textLike = /^text\/|json|xml|javascript|markdown/.test(String(file.mime || ''))
      const { bytes, size } = readWorkspaceRange(file, { offset, limit: textLike ? maxBytes : Math.floor(maxBytes * 0.75) })
      if (textLike) {
        if (offset < size && (bytes[0] & 0xc0) === 0x80) throw failure('文本读取偏移必须位于 UTF-8 字符边界', 422)
        let text
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: offset + bytes.length < size }) }
        catch { throw failure('文件不是有效 UTF-8 文本，请使用二进制读取', 422) }
        const next = offset + Buffer.byteLength(text)
        return { path: file.path, mime: file.mime, encoding: 'utf8', text, offset, bytes: next - offset, size, truncated: next < size, nextOffset: next < size ? next : null }
      }
      const next = offset + bytes.length
      return { path: file.path, mime: file.mime, encoding: 'base64', size, offset, bytes: bytes.length, base64: bytes.toString('base64'), truncated: next < size, nextOffset: next < size ? next : null }
    },
    write(userId, args: Record<string, any> = {}) {
      const path = workspaceFiles.path(String(args.path || ''))
      if (isProtectedWorkspacePath(path)) throw failure('该文件包含供应商密钥，Agent 不能修改', 403)
      const text = String(args.content ?? '')
      if (Buffer.byteLength(text, 'utf8') > 200_000) throw failure('文件内容不能超过 200KB', 413)
      const mime = typeof args.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(args.mime) ? args.mime : 'text/plain'
      const revision = workspaceFiles.upsert(userId, path, mime, Buffer.from(text, 'utf8'))
      return { path, revision, bytes: Buffer.byteLength(text, 'utf8') }
    },
  }
}

// 四个工具的定义只写一次：metadata 给 MCP 的 tools/list 用，createSharedTools 给两边执行用。
const SHARED_TOOLS = [
  {
    name: 'listSkills',
    description: '列出当前已启用的技能及用途：内置技能、当前工作区技能，以及桌面已授权的本地技能。根据任务选择，再用 readSkill 按稳定 ID 读取正文。',
    parameters: { type: 'object', properties: {} },
    run({ skills, userId }: Record<string, any>) { return { skills: skills.listSkills(userId) } },
  },
  {
    name: 'readSkill',
    description: '读取一个技能的 SKILL.md；path 可读技能目录里的引用文件（如 references/videoProduction.md）；内容长时用 nextOffset 和返回的 revision 继续读。total 为 null 时总字符数尚未读取，以 nextOffset 是否为 null 判断结束',
    parameters: {
      type: 'object',
      properties: {
        name: { ...SKILL_NAME_SCHEMA, description: 'listSkills 返回的稳定 id，不是显示名称或本机目录名' },
        path: { type: 'string', description: '技能内相对路径，默认 SKILL.md' },
        offset: { type: 'number', description: '从第几个字符开始，默认 0' },
        limit: { type: 'number', description: '本次读取字符数，默认 6000；不设上限，未读完时用 nextOffset 继续' },
        revision: { type: 'string', description: '续读时沿用上次返回的版本，文件变化会明确报错' },
      },
      required: ['name'],
    },
    async run({ skills, userId, signal }: Record<string, any>, args) {
      signal?.throwIfAborted()
      const relative = String(args.path || 'SKILL.md')
      const file = skills.readSkill(userId, String(args.name || ''), relative)
      if (args.revision !== undefined && args.revision !== file.revision) throw failure('技能文件已更新，请从所需位置重新读取', 409)
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      if (!Number.isSafeInteger(offset)) throw failure('读取位置无效', 422)
      const requested = Number(args.limit)
      const limit = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 6_000
      const details = { name: args.name, path: relative, revision: file.revision, ...(file.directory ? { directory: file.directory, location: file.path } : {}) }
      if (file.readPage) return { ...details, ...await file.readPage({ offset, limit, signal }) }
      const full = Buffer.from(file.bytes).toString('utf8')
      const content = full.slice(offset, offset + limit)
      const nextOffset = offset + content.length < full.length ? offset + content.length : null
      return { ...details, offset, total: full.length, nextOffset, content }
    },
  },
  ...WEB_TOOLS,
]

/** MCP 的 SERVER_TOOLS 直接拼这一份（只有 name/description/parameters）。 */
export const sharedToolMetadata = SHARED_TOOLS.map(({ name, description, parameters }: Record<string, any>) => ({ name, description, parameters }))

/**
 * 建一份可执行的共享工具。context 里带 workspaceFiles / fetchImpl / userId；
 * Agent 在创建时就把 userId 定死，MCP 每次调用时用 call 覆盖成令牌解出来的账号。
 */
export function createSharedTools({ workspaceFiles, fetchImpl = fetch, userId = '', webTools, webToolsForUser, localSkills }: Record<string, any>) {
  const context = { skills: createSkillStore({ workspaceFiles, localSkills }), web: webTools || (webToolsForUser ? undefined : createWebTools({ fetchImpl })), userId }
  return SHARED_TOOLS.map(({ name, description, parameters, run }: Record<string, any>) => ({
    name,
    description,
    parameters,
    execute: (args: Record<string, any> = {}, call: Record<string, any> = {}) => {
      const current = { ...context, ...call }
      // MCP instances are shared across accounts. Bind the authenticated caller
      // at execution, while native desktop keeps its existing remote web object.
      if (!webTools && webToolsForUser && WEB_TOOLS.some(tool => tool.name === name)) current.web = webToolsForUser(current.userId)
      return run(current, args)
    },
  }))
}
