// 给扩展的工作区文件能力：把妙图的工作区文件封装包成上游契约的形状。
// 扩展只拿得到当前资源所在的工作区，全部路径都是这个工作区里的相对路径。
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { writeClipboardText } from "@/lib/clipboard";
import type { ExtFiles } from "./types";
import { isCanvasFile } from "@/pages/workspace/canvasFile";

type WorkspaceFiles = ReturnType<typeof useWorkspaceFiles>;

// 上游的 read() 返回 ArrayBuffer；妙图的封装返回 Blob，这里转换一次，保持扩展侧的写法一致。
// 委托现有文件接口处理取消、版本和原生复制，避免重新实现读写回退。
export function extFiles(files: WorkspaceFiles, { copyCanvasFiles, signal }: {
  copyCanvasFiles?: (path: string, target: string, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
} = {}): ExtFiles {
  return {
    list: (path, signal) => files.list(path, signal),
    async read(path) {
      return (await files.read(path)).arrayBuffer();
    },
    readText: (path, maxBytes, signal) => files.readText(path, maxBytes, signal),
    readJson: (path, signal) => files.readJson(path, signal),
    write: (path, content, exclusive, signal) => files.write(path, content, exclusive, signal),
    writeJson: (path, data, exclusive) => files.writeJson(path, data, exclusive),
    acquireUrl: (path) => files.acquireUrl(path),
    rename: (path, target) => files.rename(path, target),
    async copy(path, target) {
      signal?.throwIfAborted();
      if (copyCanvasFiles) {
        const { entries } = await files.list(undefined, signal);
        const candidates = entries.filter(entry => entry.type === 'file' && /\.json$/i.test(entry.path)
          && (entry.path === path || entry.path.startsWith(path + '/')));
        const canvases = await Promise.all(candidates.map(entry => isCanvasFile(files, entry.path, signal)));
        signal?.throwIfAborted();
        if (canvases.some(Boolean)) { await copyCanvasFiles(path, target, signal); return; }
      }
      await files.copy(path, target, signal, { allowLegacy: true });
    },
    remove: (path, recursive) => files.remove(path, recursive),
    mkdir: (path) => files.mkdir(path),
  };
}

export { writeClipboardText };
