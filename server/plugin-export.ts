// 插件导出：MiaoImg 的 /api/plugins/export 在妙图里的实现
// （上游 apps/server/src/routes/plugins/export.ts）。
//
// 与上游的差异只有一条：上游要求「请在桌面端或服务器本机导出插件」（本机工作区直读磁盘），
// 妙图是托管形态，账号工作区在服务端，所以导出按登录账号 + 当前项目取文件，
// 能力本身（把装进来的插件再导出成文件）与本机形态一致。
//
// 只导出工作区里真实存在的东西：节点脚本、文件扩展脚本、技能目录（打成 ZIP）。
// 工具插件与团队在妙图里没有安装入口，因此这里也不提供对应的导出分支。
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zip } from 'fflate'
import { failure } from './management-store.ts'
import { MAX_PLUGIN_BYTES, SKILL_NAME_PATTERN } from './plugin-install.ts'
import { validNodeName } from './node-plugins.ts'
import { validExtName } from './ext-plugins.ts'

const SKILL_ROOT = 'skills'
const MAX_ENTRIES = 2000
// 随产品发布的内置技能（对应上游 packages/skills）：与账号工作区里的技能一样可以导出，
// 否则用户看得见、改不了、也拿不走。
const BUILTIN_SKILLS_DIR = fileURLToPath(new URL('./builtin-skills/', import.meta.url))
const isDirectoryMime = (mime) => mime === 'inode/directory'

// 把路径拼成归档内的条目名：与上游一致，所有条目放在以插件名命名的根目录下。
function archivePath(name, relative) {
  const parts = String(relative || '').replaceAll('\\', '/').split('/').filter(part => part && part !== '.')
  if (!parts.length || parts.includes('..')) throw failure('技能包含不安全的文件路径', 422)
  return [name, ...parts].join('/')
}

function zipFiles(files) {
  return new Promise<any>((resolve, reject) => {
    zip(files, { level: 1 }, (error, data) => error ? reject(error) : resolve(data))
  })
}

export function createPluginExport({ workspaceFiles }: Record<string, any>) {
  function download(response, fileName, contentType, bytes) {
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': bytes.byteLength,
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(bytes)
  }

  // 插件脚本：工作区里存的就是可原样再装回去的产物，直接下发。
  async function exportBundle(response, userId, path, fileName) {
    const file = (await workspaceFiles.read(userId, path))
    if (!file.bytes?.byteLength) throw failure('插件脚本为空，无法导出', 404)
    if (file.bytes.byteLength > MAX_PLUGIN_BYTES) throw failure('插件脚本超过 20 MB，无法导出', 413)
    download(response, fileName, 'text/javascript; charset=utf-8', file.bytes)
  }

  // 内置技能按同一个相对路径口径读出来，未安装到工作区的技能也能导出。
  function readBuiltinSkill(name, relative) {
    const root = resolve(BUILTIN_SKILLS_DIR, name)
    const file = resolve(root, ...String(relative).split('/'))
    if (file !== root && !file.startsWith(root + sep)) throw failure('技能包含不安全的文件路径', 422)
    return new Uint8Array(readFileSync(file))
  }

  function builtinSkillEntries(name) {
    const root = resolve(BUILTIN_SKILLS_DIR, name)
    const entries = []
    const walk = (directory, prefix) => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${item.name}` : item.name
        if (item.isDirectory()) walk(join(directory, item.name), relative)
        else if (item.isFile()) entries.push(relative)
        if (entries.length > MAX_ENTRIES) throw failure(`技能最多包含 ${MAX_ENTRIES} 个文件`, 413)
      }
    }
    try { walk(root, '') } catch (error) { if (error?.status) throw error; return [] }
    return entries
  }

  async function exportSkill(response, userId, name) {
    const prefix = `${SKILL_ROOT}/${name}/`
    const entries = (await workspaceFiles.list(userId))
      .filter(entry => entry.path.startsWith(prefix) && !isDirectoryMime(entry.mime))
    const files = {}
    let total = 0
    if (entries.length) {
      if (entries.length > MAX_ENTRIES) throw failure(`技能最多包含 ${MAX_ENTRIES} 个文件`, 413)
      for (const entry of entries) {
        const file = (await workspaceFiles.read(userId, entry.path))
        total += file.bytes?.byteLength ?? 0
        if (total > MAX_PLUGIN_BYTES) throw failure('技能文件总大小超过 20 MB，无法导出', 413)
        files[archivePath(name, entry.path.slice(prefix.length))] = new Uint8Array(file.bytes)
      }
    } else {
      const builtin = builtinSkillEntries(name)
      if (!builtin.length) throw failure('技能不存在', 404)
      for (const relative of builtin) {
        const bytes = readBuiltinSkill(name, relative)
        total += bytes.byteLength
        if (total > MAX_PLUGIN_BYTES) throw failure('技能文件总大小超过 20 MB，无法导出', 413)
        files[archivePath(name, relative)] = bytes
      }
    }
    const bytes = await zipFiles(files)
    if (bytes.byteLength > MAX_PLUGIN_BYTES) throw failure('技能 ZIP 文件超过 20 MB，无法导出', 413)
    download(response, `${name}.zip`, 'application/zip', Buffer.from(bytes))
  }

  // 返回 true 表示这个请求已经处理完（含已回错误），false 交回上层继续分发。
  return async function handle(request, response, session, url) {
    if (url.pathname !== '/api/plugins/export' || request.method !== 'GET') return false
    if (session?.role !== 'user') throw failure('请先登录', 401)
    const type = String(url.searchParams.get('type') || '')
    const name = String(url.searchParams.get('name') || '')
    if (!['node', 'ext', 'skill'].includes(type)) throw failure('导出类型无效', 422)
    if (type === 'node') {
      if (!validNodeName(name)) throw failure('节点名无效', 422)
      await exportBundle(response, session.userId, `nodes/${name}.umd.js`, `${name}.umd.js`)
      return true
    }
    if (type === 'ext') {
      if (!validExtName(name)) throw failure('扩展名无效', 422)
      await exportBundle(response, session.userId, `ext/${name}.umd.js`, `${name}.umd.js`)
      return true
    }
    if (!SKILL_NAME_PATTERN.test(name)) throw failure('技能名无效', 422)
    await exportSkill(response, session.userId, name)
    return true
  }
}
