import { constants, copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// 用户亲手删除的项目、画布和文件放进系统废纸篓（Windows 为回收站）。
// 文件本来就在用户自己的电脑上：想找回就去废纸篓拖回来，想腾空间就在系统里清空。
// 先在应用目录里按原来的目录结构拼好一个文件夹（APFS 上是克隆，不额外占空间），再整个交给系统。
export type TrashEntry = { path: string; mime: string }
export type TrashSource = { diskPath?: string | null; bytes?: Uint8Array | null }
export type StagedTrash = { holder: string; target: string }

const folderName = (name: string) => String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || '妙图'

export function createSystemTrash({ directory, trashItem }: { directory: string; trashItem?: (path: string) => Promise<void> }) {
  const root = join(directory, 'system-trash')

  function stage(name: string, entries: readonly TrashEntry[], read: (path: string) => TrashSource): StagedTrash {
    const holder = join(root, randomUUID()), target = join(holder, folderName(name))
    try {
      mkdirSync(target, { recursive: true, mode: 0o700 })
      for (const entry of entries) {
        const out = join(target, ...entry.path.split('/'))
        if (entry.mime === 'inode/directory') { mkdirSync(out, { recursive: true }); continue }
        const file = read(entry.path)
        mkdirSync(dirname(out), { recursive: true })
        if (file.diskPath) copyFileSync(file.diskPath, out, constants.COPYFILE_FICLONE)
        else writeFileSync(out, file.bytes || new Uint8Array())
      }
      return { holder, target }
    } catch (error) { discard({ holder, target }); throw error }
  }

  function discard(staged: StagedTrash) { rmSync(staged.holder, { recursive: true, force: true }) }

  async function send(staged: StagedTrash) {
    if (!trashItem) throw Object.assign(new Error('当前环境无法使用系统废纸篓'), { status: 503 })
    await trashItem(staged.target)
    discard(staged)
  }

  // 上次删除后还没来得及交给系统的（比如中途退出），启动时补送一次；系统仍然不收就放弃，不在应用里囤积。
  async function flush() {
    let holders: string[] = []
    try { holders = readdirSync(root) } catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const id of holders) {
      const holder = join(root, id)
      let names: string[] = []
      try { names = readdirSync(holder) } catch { continue }
      for (const name of names) {
        try { await send({ holder, target: join(holder, name) }) } catch (error) { console.warn('[system-trash] PENDING_ITEM_DROPPED', error?.code || 'UNKNOWN') }
      }
      rmSync(holder, { recursive: true, force: true })
    }
  }

  return { stage, send, discard, flush, available: Boolean(trashItem) }
}
