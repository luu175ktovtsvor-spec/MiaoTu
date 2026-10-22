type Entry = { path: string; revision: string; mime?: string }
type Proof = { sourceEntries?: unknown }
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status })
const contains = (root: string, path: string) => path === root || path.startsWith(root + '/')

// The caller supplies the real subtree while holding the same write
// transaction that will rename, copy or remove it. A parent row alone cannot
// authorize changes to descendants created or edited after selection.
export function assertWorkspaceTreeSnapshot(root: string, entries: readonly Entry[], proof: Proof) {
  const tree = entries.some(entry => entry.mime === 'inode/directory' && entry.path === root || entry.path.startsWith(root + '/'))
  if (proof.sourceEntries === undefined) {
    if (tree) throw failure('目录缺少选中时的完整文件快照，请更新客户端并重新选择后操作')
    return
  }
  if (!Array.isArray(proof.sourceEntries)) throw failure('目录文件快照无效', 422)
  const expected = new Map<string, string>()
  for (const entry of proof.sourceEntries) {
    if (!entry || typeof entry.path !== 'string' || !contains(root, entry.path) || expected.has(entry.path)
      || typeof entry.revision !== 'string' || !entry.revision.trim()) throw failure('目录文件快照无效', 422)
    expected.set(entry.path, entry.revision)
  }
  if (expected.size !== entries.length || entries.some(entry => expected.get(entry.path) !== entry.revision)) {
    throw failure('目录内文件已更新，操作未执行，请重新选择后操作')
  }
}
