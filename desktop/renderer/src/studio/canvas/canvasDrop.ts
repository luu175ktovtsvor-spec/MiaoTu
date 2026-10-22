import { ElMessage } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import type { useVueFlow } from "@vue-flow/core";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { beginUpload, dismissUpload } from "./uploadStatus";
import { assetFileType, ASSET_MAX_BYTES } from "./assetFile";
import { nodeMediaCopyPath, readWorkspaceAsset } from './scaffold/workspaceFiles';
import { isInternalAssetPath } from '../../../../../server/workspace-path';

const assetDragType = "application/miaoimg-asset";


export function getClipboardMediaFiles(event: ClipboardEvent) {
  const transfer = event.clipboardData;
  if (!transfer) return [];
  const files = Array.from(transfer.items).filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => !!file);
  if (!files.length) files.push(...Array.from(transfer.files));
  return files.filter(file => ["image", "video", "audio"].includes(assetFileType(file).kind || ""));
}

export function startAssetDrag(event: DragEvent, entry: { type: string; path: string }) {
  if (entry.type !== "file" || !event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(assetDragType, entry.path);
}

export function isCanvasFileDrag(event: DragEvent) {
  return event.dataTransfer?.types.some(type => type === assetDragType || type === "Files") ?? false;
}

type CanvasFileContext = {
  directory: string;
  availableNodes: { type: string }[];
  signal: AbortSignal;
  flow: Pick<ReturnType<typeof useVueFlow>, "addNodes" | "screenToFlowCoordinate">;
};

export async function dropCanvasFiles(event: DragEvent, context: CanvasFileContext) {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  const path = transfer.getData(assetDragType);
  const droppedFiles = Array.from(transfer.files);
  const { signal, flow } = context;
  const position = flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  try {
    signal.throwIfAborted();
    if (path) await importWorkspaceCanvasAssets([path], position, context);
    else await importCanvasFiles(droppedFiles, position, context);
  } catch (error) {
    if (!signal.aborted) showError(error);
  }
}

export async function importWorkspaceCanvasAssets(paths: string[], position: { x: number; y: number }, context: CanvasFileContext) {
  const { signal, flow } = context;
  const files = useWorkspaceFiles(context.directory);
  const entries = await Promise.all(paths.map(async path => {
    const source = await readWorkspaceAsset(files, path, signal);
    const type = `remote-${source.kind}Node`;
    if (!context.availableNodes.some(node => node.type === type)) throw new Error(`节点类型未启用：${type}`);
    const text = source.kind === 'text' ? await files.readTextSnapshot(path, signal) : undefined;
    if (text && text.revision !== source.revision) throw new Error('素材读取期间已更新，请重新导入');
    const id = crypto.randomUUID();
    const target = source.kind !== 'text' && !isInternalAssetPath(path) ? nodeMediaCopyPath(id, path) : path;
    return { ...source, type, id, target, text: text?.text };
  }));
  signal.throwIfAborted();
  const copies = entries.filter(entry => entry.path !== entry.target).map(entry => ({ path: entry.path, target: entry.target, revision: entry.revision }));
  if (copies.length === 1) {
    const copy = copies[0]!;
    if (!await files.copy(copy.path, copy.target, signal, { revision: copy.revision })) throw new Error('当前服务尚不支持保留节点原件，请更新后重试');
  } else if (copies.length) await files.copyBatch(copies, signal);
  // A received copy receipt is already committed. Attach those references
  // before observing a later cancellation, so they remain visible in the canvas.
  flow.addNodes(entries.map((entry, index) => ({ id: entry.id, type: entry.type,
    position: { x: position.x + index * 32, y: position.y + index * 32 },
    data: { label: entry.name, ...(entry.kind === 'text' ? { textSnapshot: entry.text, textSnapshotPath: entry.path } : { outputs: { [entry.kind]: { dataType: entry.kind.toUpperCase(), value: { url: entry.target, mimeType: entry.mimeType } } } }) },
  })));
  return entries.map(entry => entry.id);
}

export async function importCanvasFiles(droppedFiles: File[], position: { x: number; y: number }, context: CanvasFileContext) {
  const { signal, flow, availableNodes } = context;
  for (const [index, file] of droppedFiles.entries()) {
    if (signal.aborted) break;
    const id = crypto.randomUUID();
    const at = { x: position.x + index * 32, y: position.y + index * 32 };
    try {
      if (!file.size) throw new Error(translate("{0}：文件不能为空", { 0: file.name }));
      if (file.size > ASSET_MAX_BYTES) throw new Error(translate("{0}：文件不能超过 100 MB", { 0: file.name }));
      const { mimeType, kind } = assetFileType(file);
      if (!kind) throw new Error(translate("{0}：该文件类型暂不支持导入画布", { 0: file.name }));
      const type = `remote-${kind}Node`;
      if (!availableNodes.some(node => node.type === type)) throw new Error(translate("{0}：请先安装并启用对应的基础节点", { 0: file.name }));
      if (kind === "text") {
        if (file.size > 10 * 1024 * 1024) throw new Error(translate("{0}：文本文件不能超过 10 MB", { 0: file.name }));
        // 文本是本地读取，没有可等的传输过程，直接连内容一起建出来。
        const textSnapshot = await file.text();
        signal.throwIfAborted();
        flow.addNodes({ id, type, position: at, data: { label: file.name, textSnapshot } });
        continue;
      }
      // 先把框建出来：上传进度就画在这个框里，不用等文件传完才看见节点。
      // 上传本身交给节点自己跑（scaffold/useNodeUpload），完成后由节点写自己的 outputs ——
      // 外部直接改 node.data.outputs 会被 nodeSkeleton 的同步覆盖掉。
      beginUpload(id, file.name, file, mimeType);
      flow.addNodes({ id, type, position: at, data: { label: file.name } });
    } catch (error) {
      dismissUpload(id);
      if (!signal.aborted) showError(error);
    }
  }
}

function showError(error: unknown) {
    ElMessage.error(error instanceof Error ? error.message : translate("文件导入失败"));
}
