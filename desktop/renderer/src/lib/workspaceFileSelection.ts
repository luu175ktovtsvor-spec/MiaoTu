export type WorkspaceSourceEntry = { path: string; revision: string };

// Capture the exact indexed tree the user selected. Implicit parent directories
// have no row and must not be invented in the mutation's proof.
export function captureWorkspaceSourceEntries(entries: readonly { path: string; revision?: string }[], path: string): WorkspaceSourceEntry[] {
  const selected = entries.filter(entry => entry.path === path || entry.path.startsWith(path + '/'));
  if (!selected.length || selected.some(entry => !entry.revision)) throw new Error('文件版本尚未确认，请刷新文件列表后重新操作');
  return selected.map(entry => ({ path: entry.path, revision: entry.revision! }));
}

export function workspaceSourceRevision(entries: readonly WorkspaceSourceEntry[], path: string) {
  return entries.find(entry => entry.path === path)?.revision ?? null;
}

// Only this editor's successful CAS receipts may advance an earlier selection.
// A fresh read or a merged canvas save establishes a new, separate baseline.
export function createFileRevisionOwner() {
  let current = '';
  let known = new Set<string>();
  const reset = (revision?: string) => { current = revision || ''; known = new Set(current ? [current] : []); };
  return {
    reset,
    written(before: string, after: string) {
      if (!before || !after || before !== current || !known.has(before)) { reset(after); return; }
      current = after;
      known.add(after);
    },
    resolve: (selected: string) => known.has(selected) ? current : undefined,
  };
}
