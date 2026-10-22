// 浏览器端 FFmpeg：把 fluent 调用序列化成 JSON，交给服务端 /api/ffmpeg/execute 执行。
// 执行库、媒体文件和真实进程都留在宿主，浏览器只传“方法名 + 参数”，所以这里没有
// 任何平台依赖，也不需要打包 FFmpeg 二进制。事件流形状与服务端 ffmpeg-exec.ts 一致。

// fluent-ffmpeg 的方法表：与服务端 server/ffmpeg-exec.ts 的 chainMethods / runMethods /
// queryMethods 逐条对齐。浏览器只传方法名，真正的参数拼装和路径校验都在服务端。
export const chainMethods = [
  "input", "addInput", "mergeAdd", "withInputFormat", "inputFormat", "fromFormat",
  "withInputFps", "withInputFPS", "withFpsInput", "withFPSInput", "inputFPS", "inputFps", "fpsInput", "FPSInput",
  "nativeFramerate", "withNativeFramerate", "native", "setStartTime", "seekInput", "loop",
  "withNoAudio", "noAudio", "withAudioCodec", "audioCodec", "withAudioBitrate", "audioBitrate",
  "withAudioChannels", "audioChannels", "withAudioFrequency", "audioFrequency", "withAudioQuality", "audioQuality",
  "withAudioFilter", "withAudioFilters", "audioFilter", "audioFilters", "withNoVideo", "noVideo",
  "withVideoCodec", "videoCodec", "withVideoBitrate", "videoBitrate", "withVideoFilter", "withVideoFilters", "videoFilter", "videoFilters",
  "withOutputFps", "withOutputFPS", "withFpsOutput", "withFPSOutput", "withFps", "withFPS", "outputFPS", "outputFps", "fpsOutput", "FPSOutput", "fps", "FPS",
  "takeFrames", "withFrames", "frames", "keepPixelAspect", "keepDisplayAspect", "keepDisplayAspectRatio", "keepDAR",
  "withSize", "setSize", "size", "withAspect", "withAspectRatio", "setAspect", "setAspectRatio", "aspect", "aspectRatio",
  "applyAutopadding", "applyAutoPadding", "applyAutopad", "applyAutoPad", "withAutopadding", "withAutoPadding", "withAutopad", "withAutoPad", "autoPad", "autopad",
  "addOutput", "output", "seekOutput", "seek", "withDuration", "setDuration", "duration", "toFormat", "withOutputFormat", "outputFormat", "format", "map",
  "addInputOption", "addInputOptions", "withInputOption", "withInputOptions", "inputOption", "inputOptions",
  "addOutputOption", "addOutputOptions", "addOption", "addOptions", "withOutputOption", "withOutputOptions", "withOption", "withOptions", "outputOption", "outputOptions",
  "filterGraph", "complexFilter", "clone", "renice",
] as const;

export const runMethods = [
  "run", "save", "saveToFile", "takeScreenshots", "thumbnail", "thumbnails", "screenshot", "screenshots", "mergeToFile", "concatenate", "concat",
] as const;

export const queryMethods = [
  "ffprobe", "availableFilters", "getAvailableFilters", "availableCodecs", "getAvailableCodecs",
  "availableEncoders", "getAvailableEncoders", "availableFormats", "getAvailableFormats",
] as const;

export interface FfmpegProgress {
  frames: number;
  currentFps: number;
  currentKbps: number;
  targetSize: number;
  timemark: string;
  percent?: number;
}

export interface FfmpegCodecData {
  format: string;
  audio: string;
  audio_details: string[];
  video: string;
  video_details: string[];
  duration: string;
}

export interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  disposition?: Record<string, number>;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  [key: string]: unknown;
}

export interface FfprobeFormat {
  filename?: string;
  format_name?: string;
  format_long_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  [key: string]: unknown;
}

export interface FfprobeData {
  streams: FfprobeStream[];
  format: FfprobeFormat;
  chapters?: unknown[];
}

export type FilterSpecification = string | { filter: string; options?: unknown; inputs?: string | string[]; outputs?: string | string[] };

export interface ScreenshotsConfig {
  count?: number;
  folder?: string;
  filename?: string;
  timemarks?: (number | string)[];
  timestamps?: (number | string)[];
  size?: string;
}

export type BrowserFfmpegOptions = {
  source?: string;
  cwd?: string;
  niceness?: number;
  priority?: number;
  stdoutLines?: number;
  timeout?: number;
};

export type FfmpegCall = { method: string; args: unknown[]; undefinedArgs?: number[] };
export type BrowserFfmpegRequest = { directory: string; requestId: string; options: BrowserFfmpegOptions; calls: FfmpegCall[]; operation: FfmpegCall };
export type FfmpegRemoteEvent = { event: string; args: unknown[] };

export type BrowserFfmpegEvents = {
  start: [command: string];
  progress: [progress: FfmpegProgress];
  stderr: [line: string];
  codecData: [data: FfmpegCodecData];
  filenames: [filenames: string[]];
  end: [stdout: string | null, stderr: string | null];
  error: [error: Error, stdout?: string | null, stderr?: string | null];
};

type ChainMethod = typeof chainMethods[number];
type RunMethod = typeof runMethods[number];
type QueryMethod = typeof queryMethods[number];

/** 浏览器保留文件型 fluent API；Node.js Stream、子进程和执行程序路径由宿主管理。 */
export type BrowserFfmpegCommand = {
  [K in ChainMethod]: (...args: unknown[]) => BrowserFfmpegCommand;
} & {
  [K in RunMethod]: (...args: unknown[]) => void;
} & {
  [K in QueryMethod]: (...args: unknown[]) => void;
} & {
  on<K extends keyof BrowserFfmpegEvents>(event: K, listener: (...args: BrowserFfmpegEvents[K]) => void): BrowserFfmpegCommand;
  once: BrowserFfmpegCommand["on"];
  addListener: BrowserFfmpegCommand["on"];
  off: BrowserFfmpegCommand["on"];
  removeListener: BrowserFfmpegCommand["on"];
  removeAllListeners(event?: keyof BrowserFfmpegEvents): BrowserFfmpegCommand;
  preset(preset: (command: BrowserFfmpegCommand) => void): BrowserFfmpegCommand;
  usingPreset: BrowserFfmpegCommand["preset"];
  kill(signal?: "SIGKILL" | "SIGTERM"): BrowserFfmpegCommand;
};

export type BrowserFfmpegFactory = {
  (options?: BrowserFfmpegOptions): BrowserFfmpegCommand;
  (input?: string, options?: BrowserFfmpegOptions): BrowserFfmpegCommand;
} & {
  [K in QueryMethod]: (...args: unknown[]) => void;
};

const chainNames = new Set<string>(chainMethods);
const runNames = new Set<string>(runMethods);
const queryNames = new Set<string>(queryMethods);
type Listener = (...args: any[]) => void;

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (["function", "symbol", "bigint"].includes(typeof item) || (typeof item === "number" && !Number.isFinite(item))) {
      throw new Error("浏览器 FFmpeg 参数必须可序列化；请传入工作区文件路径");
    }
    return item;
  }));
}

function createCall(method: string, args: unknown[]): FfmpegCall {
  // JSON 会把位置参数 undefined 变成 null；保留原生可选参数的含义。
  return snapshot({ method, args, undefinedArgs: args.flatMap((value, index) => value === undefined ? [index] : []) });
}

function remoteError(value: unknown) {
  const details = (value ?? {}) as { message?: string; name?: string; code?: string };
  return Object.assign(new Error(details.message || "FFmpeg 执行失败"), details);
}

async function request(input: BrowserFfmpegRequest, signal?: AbortSignal) {
  const response = await fetch("/api/ffmpeg/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-miaoimg-workspace": "1" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) throw remoteError(await response.json().catch(() => ({})));
  return response;
}

/** 逐条读出 SSE 的 data 载荷；注释行（心跳）和空块直接跳过。 */
async function* readEventData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) yield data;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 只传输 fluent 调用，执行库和媒体文件始终留在宿主。目录在创建工厂时固定。 */
export async function createBrowserFfmpeg(directory: string, signal?: AbortSignal): Promise<BrowserFfmpegFactory> {
  signal?.throwIfAborted();
  const prepared = await request({ directory, requestId: crypto.randomUUID(), options: {}, calls: [], operation: { method: "prepare", args: [] } }, signal);
  const result = await prepared.json() as { code: number; message?: string };
  if (result.code !== 200) throw remoteError(result);

  function createCommand(options: BrowserFfmpegOptions, calls: FfmpegCall[] = []): BrowserFfmpegCommand {
    const listeners = new Map<string, { callback: Listener; once: boolean }[]>();
    let active: AbortController | undefined;
    function emit(event: string, args: unknown[]) {
      const handlers = [...(listeners.get(event) ?? [])];
      if (event === "error" && !handlers.length) {
        queueMicrotask(() => { throw args[0]; });
      }
      for (const item of handlers) {
        if (item.once) listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== item));
        item.callback(...args);
      }
    }

    function start(operation: FfmpegCall, callback?: Listener) {
      if (active) throw new Error("当前 FFmpeg 命令正在执行；并行处理请使用 clone()");
      const input = snapshot({ directory, requestId: crypto.randomUUID(), options, calls, operation });
      const controller = active = new AbortController();
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const transport = new AbortController();
      let finished = false;
      let ready = false;
      let cancelling = false;
      const cancel = () => {
        if (!ready || finished || cancelling) return;
        cancelling = true;
        // fetch.abort 不保证传到服务端；显式取消一次，并等响应头保证任务已注册。
        void request({ ...input, options: {}, calls: [], operation: { method: "cancel", args: [] } }, AbortSignal.timeout(5000))
          .catch(error => console.error("FFmpeg 取消请求失败", error))
          .finally(() => transport.abort(requestSignal.reason));
      };
      requestSignal.addEventListener("abort", cancel, { once: true });
      void (async () => {
        requestSignal.throwIfAborted();
        const response = await request(input, transport.signal);
        ready = true;
        if (requestSignal.aborted) cancel();
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("FFmpeg 响应不是事件流");
        for await (const payload of readEventData(response.body)) {
          requestSignal.throwIfAborted();
          const { event, args } = JSON.parse(payload) as FfmpegRemoteEvent;
          if (["error", "end", "result"].includes(event)) {
            finished = true;
            active = undefined;
          }
          if (event === "error") {
            const error = remoteError(args[0]);
            if (callback) callback(error);
            else emit("error", [error, ...args.slice(1)]);
          } else if (event === "result") callback?.(null, args[0]);
          else emit(event, args);
          if (finished) break;
        }
        if (!finished) throw new Error("FFmpeg 连接已断开，未收到完成结果");
      })().catch(error => {
        if (active === controller) active = undefined;
        if (finished) queueMicrotask(() => { throw error; });
        else if (callback) callback(error);
        else emit("error", [error]);
      }).finally(() => requestSignal.removeEventListener("abort", cancel));
    }

    const command = new Proxy({} as BrowserFfmpegCommand, {
      get(_target, name: string) {
        if (["on", "once", "addListener"].includes(name)) return (event: string, callback: Listener) => {
          if (typeof callback !== "function") throw new Error("FFmpeg 事件监听器必须是函数");
          listeners.set(event, [...(listeners.get(event) ?? []), { callback, once: name === "once" }]);
          return command;
        };
        if (["off", "removeListener"].includes(name)) return (event: string, callback: Listener) => {
          const handlers = listeners.get(event) ?? [];
          const index = handlers.findLastIndex(item => item.callback === callback);
          if (index >= 0) handlers.splice(index, 1);
          return command;
        };
        if (name === "removeAllListeners") return (event?: string) => {
          if (event) listeners.delete(event);
          else listeners.clear();
          return command;
        };
        if (name === "kill") return (mode = "SIGKILL") => {
          if (!["SIGKILL", "SIGTERM"].includes(mode)) throw new Error("浏览器 FFmpeg 仅支持取消任务");
          active?.abort(new DOMException("FFmpeg 任务已取消", "AbortError"));
          return command;
        };
        if (["preset", "usingPreset"].includes(name)) return (preset: (command: BrowserFfmpegCommand) => void) => {
          if (typeof preset !== "function") throw new Error("浏览器 FFmpeg 预设请使用本地函数");
          preset(command);
          return command;
        };
        if (name === "clone") return () => createCommand(snapshot(options), [...snapshot(calls), { method: "clone", args: [] }]);
        if (queryNames.has(name)) return (...args: unknown[]) => {
          const callback = args.pop();
          if (typeof callback !== "function") throw new Error("FFmpeg 查询需要回调函数");
          start(createCall(name, args), callback as Listener);
        };
        if (runNames.has(name) || chainNames.has(name)) return (...args: unknown[]) => {
          const call = createCall(name, args);
          if (runNames.has(name)) start(call);
          else {
            if (active) throw new Error("FFmpeg 执行期间不能修改配置");
            calls.push(call);
          }
          return name === "run" ? undefined : command;
        };
        // 不伪装 Promise、Node.js Stream 或子进程，未知属性按普通对象返回 undefined。
        return undefined;
      },
    });
    return command;
  }

  const factory = ((input?: string | BrowserFfmpegOptions, options?: BrowserFfmpegOptions) => {
    return createCommand(snapshot(typeof input === "object" ? input : { ...options, source: input }));
  }) as BrowserFfmpegFactory;
  for (const method of queryMethods) {
    Object.assign(factory, {
      [method]: (...args: unknown[]) => {
        const command = method === "ffprobe" ? factory(args.shift() as string) : factory();
        Reflect.apply(command[method] as (...rest: unknown[]) => void, command, args);
      },
    });
  }
  return factory;
}
