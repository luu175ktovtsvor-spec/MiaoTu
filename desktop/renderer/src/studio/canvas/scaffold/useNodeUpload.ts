import { computed, inject, onScopeDispose, watch } from "vue";
import { translate } from "@miaoimg/i18n/vue";
import { uploadEntry, dismissUpload, finishUpload, retryUpload, setUploadProgress } from "../uploadStatus";
import { useNodeFiles } from "./workspaceFiles";
import { useMediaPublication } from "./mediaPublication";
import type { NodeOutputs } from "./values";

/**
 * 画布拖入/粘贴文件时，节点先被建出来，上传由节点自己跑 —— 进度就画在这个节点的框里，
 * 而不是去画布中间飘一条全局提示。上传完成后由节点把结果写进自己的 outputs，
 * 走的还是节点「替换素材」那条路（node.data.outputs 的同步由 nodeSkeleton 负责，
 * 外部直接改 data.outputs 会被它覆盖，所以必须由节点自己写）。
 */
export function useNodeUpload(id: string, apply: (path: string, mimeType: string) => void, outputs?: () => NodeOutputs | undefined) {
  const { uploadFile, getWorkspaceFiles } = useNodeFiles();
  const getDirectory = inject<(() => string) | undefined>("workspaceDirectory", undefined);
  const capturePublication = useMediaPublication(outputs);
  let controller: AbortController | undefined;

  const entry = computed(() => uploadEntry(id));
  const uploading = computed(() => entry.value?.status === "pending" || entry.value?.status === "uploading");
  let mountedPending = true;

  watch(() => [entry.value, entry.value?.status] as const, ([current, status]) => {
    const initialUpload = mountedPending;
    mountedPending = false;
    if (!current || status !== "pending") return;
    const file = current.file;
    const mimeType = current.mimeType || file?.type || "application/octet-stream";
    if (!file && !current.saved) return;
    controller?.abort();
    const next = new AbortController();
    controller = next;
    const directory = getDirectory?.() || "";
    const isCurrent = () => uploadEntry(id) === current;
    void (async () => {
      const checkPublication = capturePublication(initialUpload);
      checkPublication(next.signal);
      let path: string;
      if (current.saved) {
        const saved = current.saved;
        if (saved.directory !== directory) throw new Error(translate("工作区已变化，请从原项目取用已保存素材"));
        if (!saved.revision) throw new Error(translate("素材已保存，但原写入回执缺少修订号，请从素材库重新选择"));
        const workspace = getWorkspaceFiles();
        if (!workspace.stat) throw new Error(translate("当前工作区无法确认已保存素材，请从素材库重新选择"));
        const stored = await workspace.stat(saved.path, next.signal);
        if (stored.revision !== saved.revision || stored.size !== saved.size || stored.mime.split(";")[0]!.trim().toLowerCase() !== saved.mimeType.toLowerCase()) {
          throw new Error(translate("已保存素材发生变化，请从素材库重新选择"));
        }
        path = saved.path;
      } else {
        path = await uploadFile(id, file!, percent => { if (isCurrent()) setUploadProgress(id, percent); }, next.signal, receipt => {
          if (isCurrent()) {
            current.saved = { ...receipt, directory, size: file!.size, mimeType };
            if (receipt.revision) current.file = undefined;
          }
        });
      }
      if (!isCurrent()) return;
      checkPublication(next.signal, path);
      apply(path, mimeType);
      if (isCurrent()) {
        finishUpload(id, true);
      }
    })()
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
        const detail = message || (error instanceof Error ? error.message : translate("上传失败"));
        finishUpload(id, false, current.saved && !detail.includes(current.saved.path) ? `${detail}；${translate("素材已保留")}：${current.saved.path}`
          : next.signal.aborted ? translate("上传已中断，请重试") : detail);
      });
  }, { immediate: true, flush: "sync" });

  onScopeDispose(() => controller?.abort());

  return { entry, uploading, retry: () => retryUpload(id), dismiss: () => dismissUpload(id) };
}
