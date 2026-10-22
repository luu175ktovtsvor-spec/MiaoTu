// 节点里的媒体处理能力：浏览器侧只做调用序列化，真正的 ffmpeg / ffprobe 在服务端跑。
import { inject, onScopeDispose } from "vue";
import { createBrowserFfmpeg } from "./browserFfmpeg";
import { translate } from "@miaoimg/i18n/vue";

export type { BrowserFfmpegFactory, BrowserFfmpegCommand, BrowserFfmpegOptions, FfprobeData } from "./browserFfmpeg";

export function useNodeFfmpeg() {
  const getDirectory = inject<(() => string) | undefined>("workspaceDirectory", undefined);
  const lifetime = new AbortController();
  onScopeDispose(() => lifetime.abort());

  return (signal?: AbortSignal) => {
    if (!getDirectory) throw new Error(translate("当前画布未提供工作区目录"));
    return createBrowserFfmpeg(getDirectory(), signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal);
  };
}
