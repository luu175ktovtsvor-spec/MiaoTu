import { hasCanvasMarker } from '../../../../../server/canvas-document.ts'
import type useWorkspaceFiles from "@/lib/workspaceFiles";
import { isCanvasFile } from "@/pages/workspace/canvasFile";
import { translate } from "@miaoimg/i18n/vue";
import type { WorkspaceSourceEntry } from '@/lib/workspaceFileSelection';

type Files = ReturnType<typeof useWorkspaceFiles>;
export type WorkspaceEntry = { name: string; path: string; type: "file" | "directory"; mime?: string; revision?: string; size?: number };
export type WorkspaceFileChange = { path: string; target?: string; recursive?: boolean; sourceEntries?: readonly WorkspaceSourceEntry[] };
export type WorkspaceFileMutator = (directory: string, change: WorkspaceFileChange, signal?: AbortSignal) => Promise<void>;
export type WorkspaceFileCopier = (directory: string, path: string, target: string, signal?: AbortSignal, sourceEntries?: readonly WorkspaceSourceEntry[]) => Promise<void>;
export type WorkspaceFileCoordinator = (directory: string, change: WorkspaceFileChange, commit: () => Promise<void>, signal?: AbortSignal) => Promise<void>;
export type CanvasTextNode = { nodeId: string; label: string; nodeType?: string };
export type DocumentEntry =
  | { kind: "file"; path: string; label: string }
  | { kind: "node"; path: string; label: string; nodeId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// 妙图的工作区接口一次返回账号下的全部文件，没有按目录分页；文件树、快速打开和
// 全文搜索都复用这一份清单，在浏览器里按路径前缀分目录。
export async function readEntryList(files: Files, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { entries } = await files.list(undefined, signal);
  signal?.throwIfAborted();
  return entries as WorkspaceEntry[];
}

export function parentPath(path: string) {
  return path.split("/").slice(0, -1).join("/");
}

export function childPath(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

export function remapWorkspacePath(path: string, source: string, target: string) {
  return path === source || path.startsWith(`${source}/`) ? target + path.slice(source.length) : path;
}

// 与 canvasHost 的 documentHandles 同构：有 STRING 类型 source 句柄，或 outputs 里有 STRING 输出。
// 只有这些节点才有可编辑正文，文件树与快速打开只列它们。
export function canvasTextNodes(canvas: unknown): CanvasTextNode[] {
  if (!isRecord(canvas) || !hasCanvasMarker(canvas) || !Array.isArray(canvas.nodes)) throw new Error("不是有效的画布文件");
  return canvas.nodes.flatMap((node): CanvasTextNode[] => {
    if (!isRecord(node) || typeof node.id !== "string" || !node.id || !isRecord(node.data)) return [];
    const handles = Array.isArray(node.data.handles) ? node.data.handles : [];
    const hasText = handles.length
      ? handles.some((handle) => isRecord(handle) && handle.type === "source"
        && (Array.isArray(handle.dataType) ? handle.dataType : [handle.dataType]).includes("STRING"))
      : isRecord(node.data.outputs) && Object.values(node.data.outputs).some((output) =>
        isRecord(output) && output.dataType === "STRING" && typeof output.value === "string");
    if (!hasText) return [];
    return [{
      nodeId: node.id,
      label: typeof node.data.label === "string" && node.data.label.trim() && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(node.data.label)
        ? node.data.label : `${translate("未命名节点")} · ${node.id.slice(0, 8)}`,
      nodeType: typeof node.type === "string" ? node.type : undefined,
    }];
  }).sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { numeric: true }));
}

export async function readCanvasTextNodes(files: Files, path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const canvas = await files.readJson(path, signal);
  signal?.throwIfAborted();
  return canvasTextNodes(canvas);
}

// 快速打开要一次扫完工作区：跳过素材目录，画布文件展开成文本节点。
export async function listDocumentEntries(files: Files, options: { limit?: number; onError?: (path: string, error: unknown) => void; signal?: AbortSignal } = {}) {
  const { limit = 10000, onError, signal } = options;
  // ACT: 单次扫描上限 10000 条；更大的工作区应改走服务端索引，不在浏览器保存全量清单。
  const entries = (await readEntryList(files, signal)).filter((entry) => entry.path !== "assets" && !entry.path.startsWith("assets/"));
  signal?.throwIfAborted();
  const documents: DocumentEntry[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (documents.length >= limit) break;
    if (entry.type === "directory") continue;
    if (!/\.json$/i.test(entry.path)) { documents.push({ kind: "file", path: entry.path, label: entry.name }); continue; }
    try {
      const canvas = await isCanvasFile(files, entry.path, signal);
      signal?.throwIfAborted();
      if (!canvas) { documents.push({ kind: "file", path: entry.path, label: entry.name }); continue; }
      const nodes = await readCanvasTextNodes(files, entry.path, signal);
      signal?.throwIfAborted();
      for (const node of nodes) {
        documents.push({ kind: "node", path: entry.path, label: node.label, nodeId: node.nodeId });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (onError) onError(entry.path, error);
      else documents.push({ kind: "file", path: entry.path, label: entry.name });
      signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  return documents;
}
