import type { WorkspaceFiles } from './scaffold/workspaceFiles';
import type { NodeOutput } from './scaffold/values';
import { isInternalAssetPath, isMarkdownFile, isProtectedWorkspaceTree } from '../../../../../server/workspace-path';
export type AssetOutput = { label: string; output: NodeOutput; sourcePath?: string };
export { isInternalAssetPath } from '../../../../../server/workspace-path';
// assets/ is the node-owned namespace. Organize explicit library copies while
// existing canvases, history and running tasks retain their original paths.
export function assertOrganizableAssetPath(path: string) {
  if (!path.trim() || /(^|\/)\.\.(\/|$)/.test(path) || path.startsWith('/') || /\\/.test(path)) throw new Error('请输入项目内有效素材路径');
  if (isProtectedWorkspaceTree(path)) throw new Error('供应商配置只能在设置中管理');
  if (isInternalAssetPath(path)) throw new Error('节点内部文件保持原位，请先另存到素材库再整理副本');
}
export async function saveWorkspaceAsset(files: WorkspaceFiles, source: string, path: string, exclusive = true, signal?: AbortSignal, sourceRevision?: string) {
  assertOrganizableAssetPath(path);
  signal?.throwIfAborted();
  if (sourceRevision !== undefined && !sourceRevision.trim()) throw new Error('素材版本尚未确认，请重新选择后操作');
  if (exclusive && files.copy && !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(source)
    && await files.copy(source, path, signal, sourceRevision === undefined ? undefined : { revision: sourceRevision })) return;
  // A fresh binary read has no receipt proving it is the selected version.
  if (sourceRevision !== undefined) throw new Error('当前工作区无法按选中版本另存素材，请更新后重试');
  const content = await files.read(source, signal);
  signal?.throwIfAborted();
  await files.write(path, content, exclusive, signal);
}
export async function saveCanvasAsset(files: WorkspaceFiles, output: NodeOutput, path: string, exclusive = true, signal?: AbortSignal, sourcePath?: string) {
  assertOrganizableAssetPath(path);
  signal?.throwIfAborted();
  if (typeof output.value === 'object') await saveWorkspaceAsset(files, output.value.url, path, exclusive, signal);
  else {
    let text = String(output.value);
    if (output.dataType === 'STRING' && sourcePath && isMarkdownFile(path)) {
      const { rebaseMarkdownPaths } = await import('../../../../../server/markdown-rebase.ts');
      text = rebaseMarkdownPaths(text, sourcePath, path);
    }
    await files.write(path, new Blob([text], { type: output.dataType === 'STRING' && isMarkdownFile(path) ? 'text/markdown' : 'text/plain' }), exclusive, signal);
  }
  return { path, dataType: output.dataType };
}

export async function createAssetFolder(files: WorkspaceFiles, folder: string, signal?: AbortSignal) {
  assertOrganizableAssetPath(folder);
  const parts = folder.split('/');
  if (!folder || folder.length > 4096 || /^(agent|settings|skills)$/i.test(parts[0]!) || parts.some(part => !part.trim() || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('素材文件夹路径无效');
  signal?.throwIfAborted(); await files.mkdir(folder, signal); signal?.throwIfAborted();
  return { folder };
}
