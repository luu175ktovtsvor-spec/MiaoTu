#!/usr/bin/env node
// 一次性回填：把已有工作区里「索引在文件末尾」的视频就地无损转封装，让老素材也能正常播放。
//
// 背景：2026-10-06 之前的上传不做转封装，QuickTime 排版（moov 在末尾、轨道分开存）的素材
// 传上来之后浏览器必须先拉完整个文件才能播——用户看到的就是「传上去了但播不了」。新上传
// 已经在写入时修掉了（server/video-normalize.ts），这个脚本负责**存量**。
//
// 关键点：
// 1. 走应用自己的 WorkspaceFiles 读写接口，不手改磁盘和数据库——路径解析、媒体根目录、
//    文件权限、索引里的 size/revision 都由它维护，和线上行为逐字节一致。
// 2. 每改一个文件都会**换新的修订号**：客户端下一次请求的 ETag 就变了，不会继续吃旧缓存。
// 3. 默认是 dry-run（只报告），要真写必须显式加 --apply。
// 4. 逐个文件处理，单个失败只记日志继续；可重复执行（已经是 faststart 的直接跳过）。
//
// 在容器里跑（数据/媒体都在挂载上）：
//   docker exec miaoimg node /app/scripts/normalize-existing-videos.ts            # 只报告
//   docker exec miaoimg node /app/scripts/normalize-existing-videos.ts --apply    # 真写
import { ManagementStore } from '../server/management-store.ts'
import { WorkspaceFiles } from '../server/workspace-files.ts'
import { looksLikeVideo, needsFaststart, normalizeVideoBuffer } from '../server/video-normalize.ts'

const apply = process.argv.includes('--apply')
const store = new ManagementStore()
const files = new WorkspaceFiles(store, { migrate: false })

const projectColumn = files.scoped ? ', project_id' : ''
// storage 为 'disk'（路径树）或 'blob'（内容寻址）的字节都在磁盘上，两种布局都要处理；
// 'db' 的字节还在库里，由服务端启动时的迁移负责落盘。
const rows = store.all(`SELECT user_id, path, mime, size${projectColumn} FROM workspace_files WHERE storage<>'db' ORDER BY updated_at`)
const videos = rows.filter((row) => looksLikeVideo(row.path, row.mime))

console.log(`[回填] 工作区文件 ${rows.length} 个，其中视频 ${videos.length} 个；模式：${apply ? '真写' : '只报告（加 --apply 才写）'}`)

let checked = 0
let needFix = 0
let fixed = 0
let failed = 0
let bytesBefore = 0
let bytesAfter = 0

for (const row of videos) {
  checked += 1
  const project = row.project_id
  try {
    const file = files.read(row.user_id, row.path, project)
    const bytes = file.bytes
    if (!bytes?.length) { console.log(`  跳过（读不到字节）：${row.path}`); continue }
    if (!needsFaststart(bytes)) continue
    needFix += 1
    const result = await normalizeVideoBuffer(bytes, { path: row.path, mime: row.mime })
    if (!result.changed) {
      console.log(`  未修改（${result.reason}）：${row.path}（${(bytes.length / 1048576).toFixed(1)}MB）`)
      failed += 1
      continue
    }
    bytesBefore += bytes.length
    bytesAfter += result.bytes.length
    if (apply) {
      // 属主/属组由落盘层统一对齐媒体根（media-files.ts 的 alignMediaOwner）：
      // 以 root 跑 docker exec 时新文件会变成 root:root，nginx（www-data 靠 miaoimg 组读）就读不到。
      // 以前是这里手工 chown，内容寻址之后文件落在 _blobs/ 下，路径由落盘层知道，脚本不再自己拼。
      const revision = files.upsert(row.user_id, row.path, row.mime, result.bytes, project)
      fixed += 1
      console.log(`  已修（rev ${String(revision).slice(0, 8)}）：${row.path} ${(bytes.length / 1048576).toFixed(1)}MB → ${(result.bytes.length / 1048576).toFixed(1)}MB（修订号已更新）`)
    } else {
      console.log(`  待修：${row.path}（${(bytes.length / 1048576).toFixed(1)}MB → ${(result.bytes.length / 1048576).toFixed(1)}MB）`)
    }
  } catch (error) {
    failed += 1
    console.error(`  失败：${row.path} ${error?.message || error}`)
  }
}

console.log(`[回填] 检查 ${checked} 个视频：需要修 ${needFix} 个，${apply ? `已修 ${fixed} 个` : '尚未写入'}，失败/跳过 ${failed} 个`)
if (needFix) console.log(`[回填] 涉及体积：${(bytesBefore / 1048576).toFixed(1)}MB → ${(bytesAfter / 1048576).toFixed(1)}MB（无损转封装，只重写容器）`)
