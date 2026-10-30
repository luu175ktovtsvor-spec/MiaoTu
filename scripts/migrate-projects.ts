#!/usr/bin/env node
import { assertLegacySQLiteMaintenance } from './legacy-sqlite-maintenance.ts'
// 工作区「多项目（一个账号下的多个工作区）」迁移。
//
//   node scripts/migrate-projects.ts               # 只报账（默认）
//   node scripts/migrate-projects.ts --report      # 同上
//   node scripts/migrate-projects.ts --apply       # 建表 -> 建默认项目 -> 加 project_id -> 复制字节
//   node scripts/migrate-projects.ts --copy-only   # 只做第 5 步的「复制+校验」，一个源字节都不删
//   node scripts/migrate-projects.ts --rollback    # 反向：字节复制回老布局 -> 结构退回单项目
//
// **搬迁是「先复制 → 逐字节校验 → 再删旧的那一份」，不是 rename。**
// 发布是「备份 → 停旧容器 → 起新容器 → 健康检查 → 失败回滚到旧容器」；rename 搬到一半崩掉，
// 老布局就只剩一半字节，回滚到旧容器对用户就是文件消失。复制完再删的话，任何时刻至少有一个布局
// 是完整的：崩在复制阶段老布局原样可用（直接回滚镜像）；崩在删除阶段新布局已经整份校验过
// （继续往前发，或者 --rollback 从新布局把老布局重建回来）。
//
// 幂等、可续跑：做过的步骤直接跳过；两个布局都有的行会先校验一致再删源，重跑不会重复复制。
// 严格：体检发现任何一行搬不动，就一行都不动，把问题行全列出来再退出。
// 迁移前就已经缺失的孤儿索引（两个布局都没有字节）加 --allow-missing 放行。
//
// 环境变量：OIP_MANAGEMENT_DB（默认 data/management.sqlite）、OIP_MEDIA_ROOT（媒体根目录）。
import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ARTIFACT_DIRECTORY, mediaRoot } from '../server/media-files.ts'
import { MEDIA_LAYOUT_BLOB, mediaLayout } from '../server/blob-store.ts'
import {
  DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, addProjectDimension, copyProjectLayout, dropProjectsTable,
  ensureProjectsSchema, ensureWorkspaceStateSchema, layoutAdvice, projectLayoutReport, pruneEmptyDirectories,
  revertWorkspaceSchema, revertWorkspaceStateSchema, tableColumns,
} from '../server/projects.ts'

assertLegacySQLiteMaintenance()

const args = process.argv.slice(2)
const has = flag => args.includes(flag)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
// --copy-only 单独给的时候按 --apply 的复制阶段跑（容易少打一个 --apply，不能让它静默变成只报账）。
const mode = has('--rollback') ? 'rollback' : (has('--apply') || has('--copy-only')) ? 'apply' : 'report'
const allowMissing = has('--allow-missing')
const dropProjects = has('--drop-projects')
const copyOnly = has('--copy-only')
const batch = Number(option('--batch', '500'))
const maintenance = process.env.OIP_MANAGEMENT_DB || join(process.env.OIP_DATA_DIR || 'data', 'management.sqlite')
const root = mediaRoot()

const number = value => Number(value || 0).toLocaleString('en-US')
const step = title => console.log(`\n[${title}]`)

// 只读打开：--report 不该顺手改库，写模式才开 WAL / 外键。
async function openStore(readOnly) {
  const db = new DatabaseSync(maintenance, readOnly ? { readOnly: true } : {})
  if (!readOnly) await db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000')
  return {
    db,
    all: async (sql, ...values) => (await (await db.prepare(sql)).all(...values)),
    get: async (sql, ...values) => (await (await db.prepare(sql)).get(...values)),
    run: async (sql, ...values) => (await (await db.prepare(sql)).run(...values)),
    async transaction(fn) { await db.exec('BEGIN IMMEDIATE'); try { const result = fn(); await db.exec('COMMIT'); return result } catch (error) { await db.exec('ROLLBACK'); throw error } },
    close: async () => (await db.close()),
  }
}

// 内容寻址迁移（scripts/migrate-media-blobs.ts）之后，字节已经不在路径树上，
// 这个脚本两个方向都做不成：往项目布局搬要读旧路径、退回去要写旧路径，两个落点都空了。
// 顺序是死的——**项目迁移必须在前、内容寻址迁移在后**。跑反了直接拒绝，并且说清先做什么，
// 免得它在半路上以「两处都缺」的样子停下来，让人以为字节丢了。
async function assertPathTreeLayout(store) {
  const layout = (await mediaLayout(store))
  // blob 列可能还不存在（新代码还没启动过）：那种库一定没迁移，按 0 处理。
  const migrated = (await tableColumns(store, 'workspace_files')).includes('blob')
    ? (await store.get('SELECT COUNT(*) AS n FROM workspace_files WHERE blob IS NOT NULL'))?.n ?? 0
    : 0
  if (layout !== MEDIA_LAYOUT_BLOB && !migrated) return
  throw new Error(`工作区字节已经搬到内容寻址存储（<账号>/_blobs/，${migrated} 行索引指向 blob），这个脚本的旧路径树已经不在了，两个方向都做不了。
  要退回路径树布局：node scripts/migrate-media-blobs.ts --rollback\n  然后才能再跑本脚本。顺序是固定的：项目迁移在前，内容寻址迁移在后。`)
}

function printReport(label, report) {
  console.log(`  ${label}`)
  console.log(`    媒体根目录 ${report.root}`)
  console.log(`    结构：${report.layout}（projects 表${report.hasProjectsTable ? '有' : '无'} / workspace_files.project_id ${report.hasProjectColumn ? '有' : '无'} / workspace_state.project_id ${report.hasWorkspaceStateProject ? '有' : '无'}）`)
  console.log(`    账号 ${number(report.users)} 个；workspace_files ${number(report.rows)} 行；workspace_state ${number(report.workspaceStateRows)} 行`)
  console.log(`    字节位置：只在旧布局 ${number(report.atOldOnly)} 行 / ${number(report.bytesAtOldOnly)} 字节，只在项目布局 ${number(report.atNewOnly)} 行 / ${number(report.bytesAtNewOnly)} 字节，两边都有 ${number(report.atBoth)} 行，两处都缺 ${number(report.atNeither)} 行`)
}

// 「判断」这一行和服务端启动日志的提醒共用 projects.ts 的 layoutAdvice，
// 保证运维看到的两种说法永远一致（不会再出现「报告说没事、启动说中间态」）。
function stage(report) {
  if (report.layout === 'legacy') return '老结构：服务端照常跑，迁移随时可以做'
  return layoutAdvice(report) || '已经是项目布局，没有待做的事'
}

// 媒体根目录指错（最常见的是忘了设 OIP_MEDIA_ROOT）时，每一行都会「两处都缺」。
// 先看一眼根目录下有没有账号目录，早一点给出人话的错误，而不是让人去读一屏缺失清单。
function assertMediaRoot(report) {
  if (!report.rows) return
  let users = 0
  try { users = readdirSync(report.root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== ARTIFACT_DIRECTORY).length } catch { users = 0 }
  if (!users) throw new Error(`媒体根目录 ${report.root} 下没有任何账号目录，八成是 OIP_MEDIA_ROOT 指错了；确认后重跑（本次一行都没动）`)
}

async function report() {
  const store = (await openStore(true))
  try {
    console.log(`工作区多项目迁移报告\n  数据库 ${maintenance}`)
    const current = (await projectLayoutReport(store, { root }))
    console.log('')
    printReport('当前状态', current)
    console.log(`\n  判断：${stage(current)}`)
  } finally { await store.close() }
}

async function apply() {
  const store = (await openStore(false))
  await assertPathTreeLayout(store)
  try {
    console.log(`工作区多项目迁移 ${copyOnly ? '--copy-only' : '--apply'}\n  数据库 ${maintenance}`)
    const before = (await projectLayoutReport(store, { root }))
    console.log('')
    printReport('迁移前', before)
    assertMediaRoot(before)

    // --copy-only：只把字节复制到项目布局并逐字节校验，**表结构一个都不动**。
    // 停在这里时老库还是老库，旧镜像、新镜像读写都正常，是这个迁移唯一一个可以随便停的安全点。
    if (copyOnly) {
      step('1/1 复制字节到 <MEDIA_ROOT>/<账号>/<项目>/ 并逐字节校验（表结构不动）')
      const copied = await copyProjectLayout(store, { direction: 'apply', root, allowMissing, copyOnly: true, batch })
      console.log('')
      printReport('复制后', (await projectLayoutReport(store, { root })))
      console.log('\n--copy-only 完成：字节整份复制并校验过，源一个字节没删，表结构一个都没动。')
      console.log('此刻旧镜像、新镜像都能正常读写。确认无误后再跑一次 --apply（会跳过复制，只改结构并清理旧位置）。')
      return
    }

    step('1/5 建 projects 表')
    await ensureProjectsSchema(store)
    console.log(`    完成，projects 表现有 ${number((await store.get('SELECT COUNT(*) AS n FROM projects')).n)} 行`)

    step('2/5 workspace_state 升到项目维度')
    const state = (await ensureWorkspaceStateSchema(store))
    console.log(state.upgraded ? `    重建完成，${number(state.rows)} 行原样保留、全部归入默认项目` : '    结构已是项目维度，跳过')

    step('3/5 复制字节到 <MEDIA_ROOT>/<账号>/<项目>/ 并逐字节校验')
    console.log('    这一步索引还是老结构，服务端读接口一直可用，源一个字节都不删。')
    const copied = await copyProjectLayout(store, { direction: 'apply', root, allowMissing, copyOnly: true, batch })

    step('4/5 workspace_files 加项目维度（重建表，主键加 project_id）')
    const files = (await addProjectDimension(store))
    console.log(files.upgraded ? `    重建完成，${number(files.rows)} 行原样保留、全部归入默认项目` : '    结构已是项目维度，跳过')

    step('5/5 建默认项目，再清理旧位置')
    const created = (await store.run(`INSERT OR IGNORE INTO projects(user_id,id,name,created_at,last_opened_at)
      SELECT DISTINCT user_id,?,?,?,NULL FROM (
        SELECT user_id FROM workspace_files UNION SELECT user_id FROM workspace_state WHERE user_id IS NOT NULL)`,
    DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, new Date().toISOString()))
    console.log(`    新建默认项目 ${number(created.changes)} 个，projects 表现有 ${number((await store.get('SELECT COUNT(*) AS n FROM projects')).n)} 行`)

    // 阶段 2：新布局已经整份校验过（上一步），这里只负责把旧的那一份删掉。
    const cleaned = await copyProjectLayout(store, { direction: 'apply', root, allowMissing, batch })
    pruneEmptyDirectories(cleaned.directories)
    console.log(`    复制阶段实际写入 ${number(copied.copied)} 行 / ${number(copied.copiedBytes)} 字节；收尾沿用 ${number(cleaned.reused)} 行、清理旧位置 ${number(cleaned.deleted)} 行`)

    const after = (await projectLayoutReport(store, { root }))
    console.log('')
    printReport('迁移后', after)
    if (after.atOldOnly || after.atBoth) throw new Error(`迁移没走完：${after.atOldOnly} 行只在旧布局、${after.atBoth} 行两个布局都还在`)
    if (after.atNeither) console.log(`\n注意：${after.atNeither} 行索引在两个布局里都没有字节（--allow-missing 放行的），media-reconcile 会继续报出来，需要人工确认。`)
    console.log('\n--apply 完成。')
  } finally { await store.close() }
}

async function rollback() {
  const store = (await openStore(false))
  await assertPathTreeLayout(store)
  try {
    console.log(`工作区多项目迁移 --rollback\n  数据库 ${maintenance}`)
    const before = (await projectLayoutReport(store, { root }))
    console.log('')
    printReport('回滚前', before)
    assertMediaRoot(before)

    if (before.hasProjectColumn) {
      step('1/4 复制字节回 <MEDIA_ROOT>/<账号>/ 并逐字节校验')
      console.log('    这一步索引还是项目结构，源一个字节都不删。')
      const copied = await copyProjectLayout(store, { direction: 'rollback', root, allowMissing, copyOnly: true, batch })
      // 先把每一行都核对到老布局，再动表结构：结构退回后就没有 project_id 可核对了。
      // 此刻项目布局那一份还没删，所以这些行是「两个布局都有」；只要没有「只在项目布局」的行就说明老布局齐了。
      const placed = (await projectLayoutReport(store, { root }))
      if (placed.atNewOnly) throw new Error(`回滚没走完：还有 ${placed.atNewOnly} 行只在项目布局，表结构保持原样未动`)
      console.log(`    逐行核对：${number(placed.atOldOnly + placed.atBoth)} 行字节都在老布局${placed.atNeither ? `；另有 ${number(placed.atNeither)} 行索引本来就没有字节（--allow-missing 放行）` : ''}`)

      if (copyOnly) {
        console.log('\n--copy-only 完成：老布局已经整份复制并校验过，项目布局一个字节都没删，表结构也没退。')
        console.log('此刻两个布局都有完整字节：新镜像照常工作；旧镜像能读、但写不了（主键还是项目结构）。')
        console.log('确认无误后再跑一次 --rollback（会跳过复制，退掉表结构并清理项目布局）。')
        return
      }

      step('2/4 workspace_files 退回 (user_id,path) 主键')
      const files = (await revertWorkspaceSchema(store))
      console.log(files.reverted ? `    重建完成，${number(files.rows)} 行原样保留` : '    结构已经是旧的，跳过')

      step('3/4 workspace_state 退回 (user_id) 主键')
      const state = (await revertWorkspaceStateSchema(store))
      console.log(state.reverted ? `    重建完成，保留默认项目 ${number(state.kept)} 行${state.dropped ? `，丢弃其它项目的草稿 ${number(state.dropped)} 行（旧代码本来也读不到）` : ''}` : '    结构已经是旧的，跳过')

      // 结构退回之后再清理项目布局那一份：此刻老布局已经整份校验过，删源不会丢数据。
      const cleaned = await copyProjectLayout(store, { direction: 'rollback', root, allowMissing, batch })
      pruneEmptyDirectories(cleaned.directories)
      console.log(`    复制阶段实际写入 ${number(copied.copied)} 行 / ${number(copied.copiedBytes)} 字节；收尾沿用 ${number(cleaned.reused)} 行、清理项目布局 ${number(cleaned.deleted)} 行`)
    } else {
      console.log('\n  workspace_files 没有 project_id 列，字节和结构都已经是老布局，没有要回滚的。')
    }

    step('4/4 projects 表')
    if (dropProjects) { await dropProjectsTable(store); console.log('    已按 --drop-projects 删除') }
    else console.log('    保留：旧代码不认这张表，留着才能在重新发布后恢复用户建过的项目；要一起清掉加 --drop-projects')

    const after = (await projectLayoutReport(store, { root }))
    console.log('')
    printReport('回滚后', after)
    console.log('\n--rollback 完成。')
  } finally { await store.close() }
}

try {
  if (mode === 'apply') await apply()
  else if (mode === 'rollback') await rollback()
  else await report()
} catch (error) {
  console.error(`\n迁移失败：${error?.message || error}`)
  process.exit(1)
}
