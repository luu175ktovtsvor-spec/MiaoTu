import { hasCanvasHeader } from '../../../../../server/canvas-document.ts'
import { isWorkspacePath } from '../../../../../server/workspace-path.ts'
import { canvasFileReferences, workspaceFileReference, type WorkspaceReferenceScope } from '../../../../../server/canvas-file-references.ts'
import { isNodeOutput } from '@miaoimg/nodes-scaffold/values';
import { translate } from '@miaoimg/i18n/vue';
import axios from "axios";
import { canvasTextSnapshotReferences } from '../../../../../server/canvas-text-snapshot.ts';
import type useWorkspaceFiles from "@/lib/workspaceFiles";

type CanvasAssetNode = { id: string; data?: unknown };

export function normalizeCanvasName(name: string) {
  name = name.trim();
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error(translate("画布名称不是有效文件名"));
  return name;
}

export function normalizeCanvasFolder(folder: string) {
  folder = folder.trim();
  if (!folder) return '';
  const parts = folder.split('/');
  parts.forEach(normalizeCanvasName);
  if (/^(agent|assets|settings|skills)$/i.test(parts[0]!)) throw new Error('不能使用项目保留目录');
  return parts.join('/');
}

export function assertCanvasFilePath(path: string) {
  if (!isWorkspacePath(path) || !/\.json$/i.test(path)) throw new Error(translate("画布文件须保留 .json 后缀并使用项目内有效路径"));
  normalizeCanvasName(path.split('/').at(-1)!.slice(0, -5));
  normalizeCanvasFolder(path.split('/').slice(0, -1).join('/'));
}

// 后台画布和撤销历史仍持有这些文件；外部文件工具不能绕过节点的保存生命周期。
export function getRetainedCanvasPaths(nodes: CanvasAssetNode[], scope?: WorkspaceReferenceScope) {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (scope) { const reference = workspaceFileReference(value, scope); if (reference?.sameScope) paths.add(reference.path); return; }
    if (isWorkspacePath(value) && !/^[a-z][a-z\d+.-]*:/i.test(value)) paths.add(value);
  };
  for (const node of nodes) {
    add(`assets/${node.id}`);
    if (!node.data || typeof node.data !== 'object') continue;
    const data = node.data as Record<string, unknown>;
    add(data.textPath);
    add(data.modelPath);
    if (data.outputs && typeof data.outputs === 'object') {
      for (const output of Object.values(data.outputs)) {
        if (isNodeOutput(output) && output.value && typeof output.value === 'object') add(output.value.url);
      }
    }
  }
  if (scope) for (const reference of canvasFileReferences(nodes, scope)) paths.add(reference.path);
  return [...paths];
}

// 与上游 apps/web/src/pages/workspace/canvasFile.ts 同构：算出「只被这张画布引用」的节点素材目录。
// 节点素材放在 assets/<nodeId>/，删除画布时只清理没有其它画布引用的目录。
export function getCanvasAssetDirectories(nodes: CanvasAssetNode[], retainedNodes: CanvasAssetNode[], retainedPaths: readonly string[] = []) {
  const retained = new Set(retainedNodes.map(node => node.id.toLowerCase()));
  const pending: unknown[] = [...retainedNodes.map(node => node.data), ...retainedPaths];
  const visited = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      const parts = value.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
      if (parts[0]?.toLowerCase() === "assets" && parts[1] && !parts.includes("..")) retained.add(parts[1].toLowerCase());
    } else if (value && typeof value === "object" && !visited.has(value)) {
      visited.add(value);
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  // 仅清理节点所属目录，不把引用路径当作目录归属，避免误删 assets/generated 等共享目录。
  return [...new Set(nodes.map(node => node.id))]
    .filter(id => id && !/[<>:"/\\|?*\x00-\x1f]/.test(id) && !/[. ]$/.test(id)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) && !retained.has(id.toLowerCase()))
    .map(id => `assets/${id}`);
}

// Body files of closed canvases and ordinary Markdown documents also own
// references. Follow links into a candidate body before deciding it is unused.
export async function getCanvasMarkdownReferences(
  files: Pick<ReturnType<typeof useWorkspaceFiles>, "readText">,
  entries: readonly { type: string; path: string }[],
  retainedNodes: CanvasAssetNode[], candidateDirectories: readonly string[],
  { signal, removedPath, scope }: { signal?: AbortSignal; removedPath?: string; scope?: WorkspaceReferenceScope } = {},
) {
  const { getMarkdownFileReferences } = await import('../../studio/canvas/nodes/textNode/markdownContent');
  const indexed = new Set(entries.filter(entry => entry.type === 'file').map(entry => entry.path));
  const markdown = (path: string) => /\.(md|markdown)$/i.test(path);
  const removed = (path: string) => !!removedPath && (path === removedPath || path.startsWith(removedPath + '/'));
  const excluded = (path: string) => removed(path) || candidateDirectories.some(directory => path.toLowerCase().startsWith(directory.toLowerCase() + '/'));
  const queued = new Set<string>(), pending: string[] = [], references = new Set<string>();
  const queue = (path: string) => { if (!queued.has(path)) { queued.add(path); pending.push(path); } };
  const collect = (paths: readonly string[]) => {
    for (const reference of paths) if (isWorkspacePath(reference)) {
      references.add(reference);
      if (markdown(reference) && indexed.has(reference) && !removed(reference)) queue(reference);
    }
  };
  const scan = (text: string, path: string) => collect(getMarkdownFileReferences(text, path, scope));
  for (const path of indexed) if (markdown(path) && !excluded(path)) queue(path);
  for (const node of retainedNodes) {
    if (!node.data || typeof node.data !== 'object') continue;
    const data = node.data as Record<string, unknown>;
    const path = isWorkspacePath(data.textPath) ? data.textPath : `assets/${node.id}/content.md`;
    if (isWorkspacePath(data.textPath)) queue(data.textPath);
    if (typeof data.textSnapshot === 'string') collect(canvasTextSnapshotReferences(data, path, scope).map(reference => reference.path));
    if (data.outputs && typeof data.outputs === 'object') for (const output of Object.values(data.outputs)) {
      if (isNodeOutput(output) && output.dataType === 'STRING' && typeof output.value === 'string') scan(output.value, path);
    }
  }
  for (let index = 0; index < pending.length; index++) {
    signal?.throwIfAborted();
    const path = pending[index]!;
    try { scan(await files.readText(path, undefined, signal), path); }
    catch (error) {
      signal?.throwIfAborted();
      throw new Error(translate('无法确认 {0} 的素材引用，已停止删除', { 0: path }), { cause: error });
    }
  }
  return [...references];
}

// 画布靠 miaoimgCanvas 标记识别，只需读文件头；读全文会让大画布被误判成普通文件。
export async function isCanvasFile(files: Pick<ReturnType<typeof useWorkspaceFiles>, "readText">, path: string, signal?: AbortSignal) {
  try {
    const header = await files.readText(path, 4096, signal);
    return hasCanvasHeader(header);
  } catch (error) {
    // 扫描期间已消失或不可作为文件读取的条目跳过，权限及其他 IO 错误继续抛出。
    if (axios.isAxiosError(error) && [400, 404].includes(error.response?.status ?? 0)) return;
    throw error;
  }
}
