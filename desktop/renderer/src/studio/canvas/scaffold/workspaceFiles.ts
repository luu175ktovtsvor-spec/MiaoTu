import { inject, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { NodeMediaValue } from "./values";
import { useNodePreviewReady } from "./useNodePreviewReady";
import { translate } from "@miaoimg/i18n/vue";
import { isInternalAssetPath, isProtectedWorkspacePath, isWorkspacePath } from '../../../../../../server/workspace-path';
import { assetFileType } from '../assetFile';
import { guardWorkspaceFiles } from '@/lib/workspaceFiles';

export interface WorkspaceFiles {
  list(path?: string): Promise<{ directory: string; entries: { name: string; path: string; type: "file" | "directory" }[] }>;
  read(path: string, signal?: AbortSignal): Promise<Blob | ArrayBuffer>;
  stat?(path: string, signal?: AbortSignal): Promise<{ path: string; mime: string; size: number; revision: string }>;
  readImageSize?(path: string, signal?: AbortSignal): Promise<{ width: number; height: number }>;
  url?(path: string): string;
  acquireUrl?(path: string, mimeType: string): { url: Promise<string>; release(): void };
  acquirePreviewUrl?(path: string, mimeType: string, maxDimension?: number): { url: Promise<string>; release(): void };
  watchUrl?(path: string, changed: () => void): () => void;
  readText(path: string): Promise<string>;
  readTextSnapshot(path: string, signal?: AbortSignal): Promise<{ text: string; revision: string }>;
  /** null 仅新建；字符串必须是编辑器读取该正文时保留的版本。 */
  writeText(path: string, text: string, revision: string | null): Promise<string>;
  readJson<T = unknown>(path: string): Promise<T>;
  /** Native writes include a revision receipt; older plugin adapters may return void. */
  write(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean, signal?: AbortSignal, onProgress?: (percent: number) => void): Promise<unknown>;
  writeJson(path: string, data: unknown, exclusive?: boolean): Promise<void>;
  rename(path: string, target: string): Promise<void>;
  /** False means the host lacks copy support and no copy was submitted. */
  copy?(path: string, target: string, signal?: AbortSignal, options?: { revision?: string }): Promise<boolean>;
  remove(path: string, recursive?: boolean): Promise<void>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
}

function getNodeDirectory(nodeId: string) {
  if (!nodeId || /[\\/]/.test(nodeId) || nodeId === "." || nodeId === "..") throw new Error("节点 ID 不能作为文件夹名称");
  return `assets/${nodeId}`;
}

export async function readWorkspaceAsset(files: WorkspaceFiles, path: string, signal?: AbortSignal, mimeHint?: string) {
  if (!isWorkspacePath(path) || isProtectedWorkspacePath(path)) throw new Error('请选择工作区内的素材文件');
  if (!files.stat) throw new Error('当前工作区尚不支持素材元信息，请更新后重试');
  const metadata = await files.stat(path, signal);
  const name = path.split('/').at(-1)!;
  const declared = assetFileType({ name, type: metadata.mime });
  const { kind, mimeType } = declared.kind || !mimeHint ? declared : assetFileType({ name, type: mimeHint });
  if (!kind || !metadata.size || kind === 'text' && metadata.size > 10 * 1024 * 1024) throw new Error(`素材不支持导入或超过大小上限：${path}`);
  return { ...metadata, name, kind, mimeType };
}

export function nodeMediaCopyPath(nodeId: string, source: string) {
  const extension = source.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? '';
  return `${getNodeDirectory(nodeId)}/${crypto.randomUUID()}${extension}`;
}

// Mutable library paths become node-owned immutable references. Existing
// internal originals can be shared, and the native copy reuses their bytes.
export async function retainNodeMedia(files: WorkspaceFiles, nodeId: string, path: string, kind: 'image' | 'video' | 'audio', signal?: AbortSignal, mimeHint?: string): Promise<NodeMediaValue> {
  const source = await readWorkspaceAsset(files, path, signal, mimeHint);
  if (source.kind !== kind) throw new Error('素材类型与节点不匹配');
  if (isInternalAssetPath(path)) return { url: path, mimeType: source.mimeType };
  const target = nodeMediaCopyPath(nodeId, path);
  if (!files.copy || !await files.copy(path, target, signal, { revision: source.revision })) throw new Error('当前服务尚不支持保留节点原件，请更新后重试');
  return { url: target, mimeType: source.mimeType };
}

const pendingPaths = new WeakMap<File, Map<string, string>>();
export type NodeFileReceipt = { path: string; revision?: string };

export async function uploadNodeFile(files: WorkspaceFiles, nodeId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal, onSaved?: (receipt: NodeFileReceipt) => void) {
  const directory = getNodeDirectory(nodeId);
  // 服务器写入会创建父路径；CAS 目录是虚拟索引，不必先发送两个空目录请求。
  const extension = file.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
  let paths = pendingPaths.get(file);
  if (!paths) { paths = new Map(); pendingPaths.set(file, paths); }
  const path = paths.get(nodeId) || `${directory}/${crypto.randomUUID()}${extension}`;
  paths.set(nodeId, path);
  const receipt: unknown = await files.write(path, file, true, signal, onProgress);
  const revision = receipt && typeof receipt === "object" && "revision" in receipt
    && typeof receipt.revision === "string" && receipt.revision.trim() ? receipt.revision : undefined;
  onSaved?.({ path, revision });
  paths.delete(nodeId);
  return path;
}

export function useNodeFiles() {
  const createFiles = inject<(() => WorkspaceFiles) | undefined>("workspaceFiles", undefined);
  const getDirectory = inject<(() => string) | undefined>('workspaceDirectory', undefined);
  const retainNodeFiles = inject("retainNodeFiles", false);

  function getWorkspaceFiles() {
    if (!createFiles) throw new Error(translate("当前画布未提供工作区文件能力"));
    return guardWorkspaceFiles(createFiles(), getDirectory?.() || '');
  }

  function uploadFile(nodeId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal, onSaved?: (receipt: NodeFileReceipt) => void) {
    // ACT: 多步上传共用开始时的工作区，避免切换项目后写入另一目录。
    return uploadNodeFile(getWorkspaceFiles(), nodeId, file, onProgress, signal, onSaved);
  }

  async function removeNodeFiles(nodeId: string) {
    const directory = getNodeDirectory(nodeId);
    // ACT: 支持撤销的画布保留节点素材，不随节点删除物理文件。
    if (retainNodeFiles) return;
    await getWorkspaceFiles().remove(directory, true).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "ENOENT") throw error;
    });
  }

  function useFileUrl(file: MaybeRefOrGetter<NodeMediaValue | undefined>, onError: (error: unknown) => void, preview: boolean | 320 = false) {
    const fileUrl = ref("");
    const fileRevision = ref(0);
    const previewReady = useNodePreviewReady();
    watch([() => {
      const value = toValue(file);
      return value ? JSON.stringify([value.url, value.mimeType]) : "";
    }, previewReady, fileRevision], async ([_identity, ready], _previous, onCleanup) => {
      const value = toValue(file);
      let cancelled = false;
      let url = "";
      let shared: ReturnType<NonNullable<WorkspaceFiles["acquireUrl"]>> | undefined;
      let unwatch: (() => void) | undefined;
      onCleanup(() => {
        cancelled = true;
        shared?.release();
        unwatch?.();
        if (url) URL.revokeObjectURL(url);
      });
      fileUrl.value = "";
      if (!value || !ready) return;
      try {
        const files = getWorkspaceFiles();
        unwatch = files.watchUrl?.(value.url, () => { fileRevision.value++; });
        shared = preview && files.acquirePreviewUrl ? files.acquirePreviewUrl(value.url, value.mimeType, preview === 320 ? 320 : 1024) : files.acquireUrl?.(value.url, value.mimeType);
        if (shared) {
          const sharedUrl = await shared.url;
          if (!cancelled) fileUrl.value = sharedUrl;
          return;
        }
        const content = await files.read(value.url);
        if (cancelled) return;
        fileUrl.value = url = URL.createObjectURL(new Blob([content], { type: value.mimeType }));
      } catch (error) {
        if (!cancelled) onError(error);
      }
    }, { immediate: true });
    return fileUrl;
  }

  return { getWorkspaceFiles, uploadFile, removeNodeFiles, useFileUrl };
}
