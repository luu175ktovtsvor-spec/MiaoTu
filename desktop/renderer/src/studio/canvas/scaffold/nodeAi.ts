import { translate } from "@miaoimg/i18n/vue";

// 妙图节点 AI 适配层。
// 图片、视频和文本节点通过统一接口读取模型能力、报价并跟踪生成任务：
//   GET  ./api/imagine/config            读取可用模型与规格
//   POST ./api/imagine/generate          图片生成（异步任务 + 轮询）
//   POST ./api/imagine/video             视频生成（异步任务 + 轮询）
// 媒体输出写回当前账号的工作区目录，账号数据随登录态保留。
import { inject } from "vue";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";
import type { NodeAiModel, NodeMediaModel } from "./nodeAiTypes";
// 外部（节点组件、settings）继续从 `@miaoimg/nodes-scaffold/nodeAi` 取这两个类型。
export type { NodeAiModel, NodeMediaModel } from "./nodeAiTypes";
import { loadUserProviders } from "@/lib/providerModels";
import type { NodeOutput } from "./values";
import { readAgentEvents } from "../components/agent/replyStream";


export type ReferenceHistory = { index: number; name: string; kind: string }[];

// Once the service has accepted a task, a local binding/save error must retain
// that identity. Its HTTP status belongs to the save, not generation admission.
export function pendingMediaTaskError(cause: unknown, requestId: string) {
  return Object.assign(new Error(translate("原任务尚未确认，请继续取回，不会重新生成。"), { cause }), {
    name: cause instanceof Error ? cause.name : "Error", generationPending: true, requestId,
  });
}

async function confirmMediaTask(request: { onTask?: (requestId: string, existing?: boolean) => void | Promise<void> }, requestId: string, existing: boolean) {
  try { await request.onTask?.(requestId, existing); }
  catch (error) { throw pendingMediaTaskError(error, requestId); }
}

function mediaTaskId(payload: Record<string, unknown>) {
  if (payload.ok === true && payload.task === null) return "";
  const task = payload.task as { requestId?: unknown } | undefined;
  if (payload.ok !== true || !task || typeof task.requestId !== "string" || !/^[A-Za-z0-9_-]+$/.test(task.requestId)) {
    throw new Error(translate("原任务查询未返回完整信息，请稍后继续取回。"));
  }
  return task.requestId;
}

export type NodeImageRequest = {
  directory: string;
  providerId: string;
  modelId: string;
  prompt: string;
  referenceHistory?: ReferenceHistory;
  outputDirectory: string;
  // 一次返回多张时，每张图写入各自的节点目录，删除生成节点不会带走其它节点的文件。
  outputDirectories?: string[];
  images?: { path: string; mimeType: string }[];
  ratio?: string;
  size?: string;
  format?: string;
  background?: string;
  quality?: string;
  inputFidelity?: string;
  count?: number;
  layerDecomposition?: boolean;
  optimizePrompt?: string;
  parameters?: Record<string, unknown>;
  // 局部重绘：mask 走原生蒙版通道（透明区 = 要改的区域），annotations 走标注通道。
  // 服务端按模型能力再校验一次，不支持的通道会直接拒绝请求。
  edit?: NodeImageEdit;
  onTask?: (requestId: string, existing?: boolean) => void | Promise<void>;
  shouldCancel?: () => boolean;
  onStatus?: (status: string, progress?: number | null, message?: string) => void;
};

// 局部重绘提示词面板回传给节点的入参；节点再补上工作区目录、原图和 edit 参数。
export type NodeInpaintInput = { providerId: string; modelId: string; prompt: string; size: string; ratio: string };

export type NodeImageEdit =
  | { mask: string }
  | { annotations: { tool: "box"; box: [number, number, number, number] }[] };

export type NodeImageResult = { path: string; mimeType: string; mediaType: "image" };
export type NodeCreditEstimate = {
  points?: number | null;
  perImage?: number | null;
  breakdown?: Record<string, unknown>;
  billingSource?: string;
  policyVersion?: string;
  pricingAvailable?: boolean;
  source?: string;
};

export type NodeVideoRequest = {
  directory: string;
  providerId: string;
  modelId: string;
  prompt: string;
  referenceHistory?: ReferenceHistory;
  outputDirectory?: string;
  images?: { path: string; mimeType: string }[];
  videos?: { path: string; mimeType: string }[];
  audios?: { path: string; mimeType: string }[];
  firstFrame?: { path: string; mimeType: string };
  lastFrame?: { path: string; mimeType: string };
  ratio?: string;
  size?: string;
  resolution?: string;
  duration?: number;
  generateAudio?: boolean;
  returnLastFrame?: boolean;
  webSearch?: boolean;
  onTask?: (requestId: string, existing?: boolean) => void | Promise<void>;
  shouldCancel?: () => boolean;
  onStatus?: (status: string, progress?: number | null, message?: string) => void;
  voice?: string;
  referenceVoices?: string[];
  speed?: number;
  volume?: number;
  format?: string;
  sampleRate?: number;
  mode?: string | string[];
  keyframes?: { image: { url: string }; timestamp_s: number }[];
};

export type NodeVideoResult = { path: string; mimeType: string; mediaType: "video" };

export type NodeAiRequest = {
  providerId: string;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  directory?: string;
  references?: Extract<NodeOutput, { dataType: "STRING" | "IMAGE" | "VIDEO" }>[];
  tools?: NodeAiTool[];
  onEvent?: (event: NodeAiEvent) => void;
  signal?: AbortSignal;
  outputDirectory?: string;
  taskId?: string;
  onTask?: (requestId: string, existing?: boolean) => void | Promise<void>;
  onTaskFinished?: (requestId: string) => void;
};

export type NodeAiResult = { text: string; reasoning?: string; requestId?: string };

export type NodeAiEvent = { type: "text" | "reasoning"; delta: string }
  | { type: "status"; message: string }
  | { type: "toolStart"; id: string; name: string; args: unknown }
  | { type: "toolEnd"; id: string; name: string; result: unknown; isError: boolean };

export type NodeAiTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): unknown | Promise<unknown>;
};


type MediaFiles = {
  list(path?: string): Promise<{ directory: string; entries: { name: string; path: string; type: string }[] }>;
  read(path: string): Promise<Blob | ArrayBuffer>;
  // A media URL lets the browser read metadata without loading the whole
  // reference video into a base64 string first. The server still checks the
  // logged-in workspace owner on every request.
  url?(path: string): string;
  write(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean): Promise<unknown>;
  mkdir(path: string): Promise<unknown>;
};

export function groupNodeModels<T extends Pick<NodeAiModel, "providerId" | "providerLabel">>(models: readonly T[]) {
  return [...Map.groupBy(models, item => item.providerId)].map(([id, items]) => ({
    id, label: items[0]!.providerLabel, models: items,
  })).sort((left, right) => Number(right.id === "miaoimg") - Number(left.id === "miaoimg"));
}

export function invalidateNodeModels(_type?: "language" | "media") {
  mediaCatalog = undefined;
  mediaCatalogValue = undefined;
  mediaCatalogLoadedAt = 0;
  runtime = undefined;
  runtimeValue = undefined;
  runtimeLoadedAt = 0;
  if (_type !== "language") window.dispatchEvent(new Event("miao-media-models"));
}

// 媒体模型目录：与第三方节点插件共用 server/ai-compat.ts 的 /api/ai/media/models，
// 不再自己解析 /api/imagine/config——目录只维护一份，字段只声明一处。
// 仅合并正在进行的请求；重新打开选择器或读取节点配置时取最新开放状态。
let mediaCatalog: Promise<NodeMediaModel[]> | undefined;
let mediaCatalogValue: NodeMediaModel[] | undefined;
let mediaCatalogLoadedAt = 0;
type TextCatalogModel = { id: string; label: string; provider?: string; providerLabel?: string; note?: string; configured?: boolean; protocol?: NodeAiModel["protocol"]; contextWindow?: number; maxOutputTokens?: number };
type RuntimeConfig = { textModels?: TextCatalogModel[]; textEnabled?: boolean; defaultTextModel?: string };
let runtime: Promise<RuntimeConfig> | undefined;
let runtimeValue: RuntimeConfig | undefined;
let runtimeLoadedAt = 0;
let modelScopeKey = "";
function bindModelScope() {
  const key = JSON.stringify(captureWorkspaceScope());
  if (key !== modelScopeKey) {
    mediaCatalog = undefined; mediaCatalogValue = undefined; mediaCatalogLoadedAt = 0;
    runtime = undefined; runtimeValue = undefined; runtimeLoadedAt = 0;
    modelScopeKey = key;
  }
}

async function loadConfig(): Promise<RuntimeConfig> {
  bindModelScope();
  if (runtimeValue && Date.now() - runtimeLoadedAt < 30_000) return runtimeValue;
  if (!runtime) {
    const pending: Promise<RuntimeConfig> = fetch("./api/imagine/config", { cache: "no-store" })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(translate("模型列表读取失败（{0}）", { 0: response.status }))))
      .then(value => { runtimeValue = value; runtimeLoadedAt = Date.now(); return value })
      .finally(() => { if (runtime === pending) runtime = undefined; });
    runtime = pending;
  }
  return runtime;
}

// 上游 /api/ai/media/models 的信封是 { code, message, data }，读取方式与上游 readResult 同形。
async function requestData<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal });
  const payload = await response.json().catch(() => ({})) as { code?: number; message?: string; data?: T };
  if (!response.ok || payload.code !== 200) throw new Error(payload.message || translate("模型列表读取失败（{0}）", { 0: response.status }));
  return payload.data as T;
}

async function loadMediaModels(): Promise<NodeMediaModel[]> {
  bindModelScope();
  if (mediaCatalogValue && Date.now() - mediaCatalogLoadedAt < 30_000) return mediaCatalogValue;
  if (!mediaCatalog) {
    // 服务端已按「管理员暂停 + 账号可用范围」过滤，节点侧不再重复判断。
    const pending: Promise<NodeMediaModel[]> = requestData<NodeMediaModel[]>("./api/ai/media/models")
      .then(value => { mediaCatalogValue = value; mediaCatalogLoadedAt = Date.now(); return value })
      .finally(() => { if (mediaCatalog === pending) mediaCatalog = undefined; });
    mediaCatalog = pending;
  }
  return mediaCatalog;
}

function ratioOf(model: NodeMediaModel | undefined, size: string | undefined) {
  return model?.sizes?.find(item => item.value === size)?.ratio || "";
}

export function fitsCustomSize(rule: NodeMediaModel["sizeRule"], size: string | undefined) {
  if (!rule || !size) return false;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = width / height;
  if (width < 1 || height < 1 || !Number.isFinite(ratio)) return false;
  if (rule.multipleOf && (width % rule.multipleOf || height % rule.multipleOf)) return false;
  if (rule.maxEdge && (width > rule.maxEdge || height > rule.maxEdge)) return false;
  return pixels >= rule.minPixels && pixels <= rule.maxPixels && ratio >= rule.minRatio && ratio <= rule.maxRatio;
}

function pickSize(model: NodeMediaModel | undefined, size: string | undefined, ratio: string | undefined) {
  const sizes = model?.sizes || [];
  const exact = sizes.find(item => item.value === size);
  if (exact) return exact.value;
  if (size && model?.customSize && /^\d{2,5}x\d{2,5}$/.test(size)) return size;
  if (size) throw new Error(translate("当前模型不支持这个生成尺寸"));
  const byRatio = ratio ? sizes.find(item => item.ratio === ratio) : undefined;
  if (byRatio) return byRatio.value;
  return sizes.find(item => item.ratio === "1:1")?.value || sizes[0]?.value || "";
}

async function toDataUrl(files: MediaFiles, path: string, mimeType: string) {
  const content = await files.read(path);
  const blob = content instanceof Blob ? content : new Blob([content as ArrayBuffer], { type: mimeType });
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  const type = blob.type || mimeType || "application/octet-stream";
  return `data:${type};base64,${btoa(binary)}`;
}

async function imageReferencePayload(files: MediaFiles, request: Pick<NodeImageRequest, "images">, model?: NodeMediaModel) {
  const images = request.images || [];
  if (model?.maxReferences !== undefined && images.length > model.maxReferences) {
    throw new Error(translate("当前模型最多支持 {0} 张参考图", { 0: model.maxReferences }));
  }
  const workspaceOnly = images.every(item => !/^(?:data:|blob:|https?:|[/])/i.test(item.path));
  if (workspaceOnly) return { referenceFiles: images.map(item => {
    const source = files.url?.(item.path);
    const revision = source ? new URL(source, window.location.origin).searchParams.get("v") : null;
    return { path: item.path, ...(revision ? { revision } : {}) };
  }) };
  return { references: await Promise.all(images.map(item => toDataUrl(files, item.path, item.mimeType))) };
}

function mediaExtension(mimeType: string, fallback: string) {
  const map: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" };
  return map[mimeType] || fallback;
}

// 在浏览器里读取参考视频的时长（秒）：秘塔、火山和 Yunshu 都会按
// 上游规则核算输入视频，读不到真实元数据时必须阻止请求，不能用猜测值扣费。
function mediaDurationSeconds(source: string): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const finish = (value: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(0), 8000);
    video.preload = "metadata";
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) && video.duration > 0
      ? Math.round(video.duration * 1000) / 1000
      : 0);
    video.onerror = () => finish(0);
    video.src = source;
  });
}

function progressValue(value: unknown): number | null {
  const raw = typeof value === "object" && value !== null
    ? (value as { progress?: unknown }).progress
    : value;
  if (raw === null || raw === undefined || !["number", "string"].includes(typeof raw) || !String(raw).replace("%", "").trim()) return null;
  const number = Number(String(raw).replace("%", ""));
  return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round(number) : null;
}

async function persistMedia(files: MediaFiles, outputDirectory: string, url: string, mimeType: string, fallbackExtension: string) {
  const directory = String(outputDirectory || "assets").replace(/\/+$/, "") || "assets";
  const path = `${directory}/${crypto.randomUUID()}.${mediaExtension(mimeType, fallbackExtension)}`;
  let content: Blob | ArrayBuffer | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      for (const folder of [...new Set(["assets", directory])]) {
        await files.mkdir(folder).catch((error: { response?: { status?: number } }) => {
          if (error.response?.status !== 409) throw error;
        });
      }
      content ||= await files.read(url);
      try {
        await files.write(path, content, true);
      } catch (error) {
        // Only an existing file with identical bytes proves that an earlier
        // write succeeded but its response was lost. A 409 can also mean the
        // account changed; never turn that into a false successful save.
        if (Number((error as { response?: { status?: number } })?.response?.status) !== 409) throw error;
        const saved = await files.read(path);
        const savedBytes = saved instanceof Blob ? await saved.arrayBuffer() : saved;
        const expected = content instanceof Blob ? await content.arrayBuffer() : content;
        if (savedBytes.byteLength !== expected.byteLength
          || new Uint8Array(savedBytes).some((byte, index) => byte !== new Uint8Array(expected)[index])) throw error;
      }
      return path;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise<void>((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  const detail = lastError instanceof Error ? translate("：{0}", { 0: lastError.message }) : "";
  throw new Error(translate("生成已完成，但素材未能保存到画布；请从生成历史找回结果，不要重复生成") + detail);
}

export function useNodeAi() {
  const requestScope = captureWorkspaceScope();
  const createFiles = inject<(() => MediaFiles) | undefined>("workspaceFiles", undefined);
  const csrf = inject<string | undefined>("miaoModelCsrf", undefined);

  function getFiles(): MediaFiles {
    if (!createFiles) throw new Error(translate("当前画布未提供工作区文件能力"));
    return createFiles();
  }

  async function getMediaModels(): Promise<NodeMediaModel[]> {
    assertWorkspaceScope(requestScope);
    return loadMediaModels();
  }

  async function requestJson(url: string, body: unknown, signal?: AbortSignal) {
    assertWorkspaceScope(requestScope);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
      body: JSON.stringify(body),
      signal,
      credentials: "same-origin",
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    assertWorkspaceScope(requestScope);
    if (!response.ok || data.ok === false) throw Object.assign(new Error(String(data.error || data.message || translate("模型请求失败（{0}）", { 0: response.status }))), { status: response.status, activeRequestId: data.activeRequestId, errorExplanation: data.errorExplanation, csrf });
    return data;
  }

  async function pollJson(url: string, signal?: AbortSignal) {
    assertWorkspaceScope(requestScope);
    const response = await fetch(url, { signal, credentials: "same-origin", cache: "no-store" });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    assertWorkspaceScope(requestScope);
    if (!response.ok || data.ok === false) throw Object.assign(new Error(String(data.error || data.message || translate("任务状态读取失败（{0}）", { 0: response.status }))), { status: response.status, errorExplanation: data.errorExplanation, csrf });
    return data;
  }

  async function pollTask(url: string, signal?: AbortSignal, onStatus?: NodeImageRequest["onStatus"]) {
    while (true) {
      signal?.throwIfAborted();
      try { return await pollJson(url, signal); }
      catch (error) {
        const status = Number((error as { status?: number }).status);
        if (status === 410) onStatus?.("expired");
        if (signal?.aborted || (error as { scopeChanged?: boolean }).scopeChanged || [401, 403, 404, 410].includes(status)) throw error;
        // Read failures retain the same request identity; never POST again.
        await wait(5000, signal);
      }
    }
  }

  function cancellationMessage(status: Record<string, unknown>) {
    const charged = status.chargedPoints ?? status.charged_points;
    if (typeof charged !== "number" || !Number.isFinite(charged)) return translate("生成已取消；费用请查看生成记录。");
    return charged > 0
      ? translate("生成已取消；请求已经发出，预扣积分不退")
      : translate("生成已取消；请求尚未发出，预扣积分已退回");
  }

  // 服务端在轮询结果里带了扣费后的余额；广播给工作台外壳，让它把顶部的积分数字更新掉。
  // 画布是独立挂载的 Vue 应用，和外壳不共享状态，所以用一次性的 window 事件解耦。
  function publishBalance(status: Record<string, unknown>) {
    const balance = Number(status.balance);
    if (!Number.isFinite(balance)) return;
    try {
      window.dispatchEvent(new CustomEvent("miaoimg:points", { detail: { points: balance } }));
    } catch { /* 事件广播失败不影响生成流程 */ }
  }

  function wait(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new DOMException(translate("已取消"), "AbortError"));
      const timer = window.setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
      function onAbort() { window.clearTimeout(timer); reject(signal!.reason ?? new DOMException(translate("已取消"), "AbortError")); }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // 用提交时固定的 requestId 核对取消回执。提交尚未登记或回执丢失时
  // 保留待确认状态，不能因观察连接已经中断就宣称后台任务已取消。
  async function cancelServerTask(requestId: string, accessToken = ""): Promise<Record<string, unknown> | null> {
    if (!requestId) return null;
    const signal = AbortSignal.timeout(15000);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        assertWorkspaceScope(requestScope);
        const query = accessToken ? `?access=${encodeURIComponent(accessToken)}` : "";
        const response = await fetch(`./api/imagine/generation/${encodeURIComponent(requestId)}/cancel${query}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
          credentials: "same-origin",
          signal,
        });
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        assertWorkspaceScope(requestScope);
        if (response.ok) return data.ok !== false && data.requestId === requestId && ["queued", "running", "saving", "succeeded", "failed", "cancelled", "expired"].includes(String(data.status)) ? data : null;
        if (![404, 409].includes(response.status)) return null;
      } catch (error) {
        if ((error as { scopeChanged?: boolean }).scopeChanged) throw error;
        if (signal.aborted) return null;
      }
      // A cancelled POST may still be completing its reservation transaction.
      if (attempt < 5) await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    }
    return null;
  }

  function cancelledResult(status: Record<string, unknown>) {
    return Object.assign(new Error(cancellationMessage(status)), { name: "AbortError", generationCancelled: true });
  }

  async function interruptedTask(error: unknown, requestId: string, request: Pick<NodeImageRequest, "onStatus" | "shouldCancel">, signal?: AbortSignal, accessToken = "") {
    if ((error as { generationCancelled?: boolean })?.generationCancelled || Number((error as { status?: number })?.status) === 410) return error;
    if (!signal?.aborted || request.shouldCancel?.() === false) return error;
    const receipt = await cancelServerTask(requestId, accessToken);
    if (receipt) {
      request.onStatus?.(String(receipt.status), progressValue(receipt.progress));
      publishBalance(receipt);
      if (receipt.status === "cancelled") return cancelledResult(receipt);
      if (["failed", "expired"].includes(String(receipt.status))) return new Error(String(receipt.error || translate("原任务已结束，请查看生成记录。")));
    }
    const message = receipt && ["succeeded", "saving"].includes(String(receipt.status))
      ? translate("生成已完成，已停止等待；点击继续取回原结果，不会重新生成。")
      : translate("取消尚未确认，原任务可能仍在后台运行；点击继续取回，核对原任务。");
    // Stopping an observer is not proof that the paid generation stopped.
    // Keep the original request so the next action resumes instead of resubmitting.
    return Object.assign(new Error(message), { name: "AbortError", generationPending: true, requestId });
  }

  async function generateImage(request: NodeImageRequest, signal?: AbortSignal): Promise<NodeImageResult[]> {
    const localMedia = ['doubao-local', 'dola-local'].includes(request.providerId);
    if (localMedia && request.edit) throw new Error(translate('当前本机路由不支持局部重绘'));
    const models = await loadMediaModels();
    const model = models.find(item => item.providerId === request.providerId && item.modelId === request.modelId);
    const files = getFiles();
    const referencePayload = await imageReferencePayload(files, request, model);
    if (localMedia && 'references' in referencePayload) throw new Error(translate('请先将参考图片保存到本机项目，再使用本机模型生成'));
    const size = localMedia ? 'auto' : pickSize(model, request.size, request.ratio || ratioOf(model, request.size));
    signal?.throwIfAborted();
    const clientRequestId = crypto.randomUUID();
    try {
      await request.onTask?.(clientRequestId);
      signal?.throwIfAborted();
    } catch (error) { request.onStatus?.("failed"); throw error; }
    let payload: Record<string, unknown>;
    try {
      payload = await requestJson("./api/imagine/generate", {
        model: request.modelId,
        providerId: request.providerId,
        prompt: request.prompt,
        referenceHistory: request.referenceHistory,
        size: size || undefined,
        ...(request.ratio ? { ratio: request.ratio } : {}),
        ...(localMedia || !request.format ? {} : { format: request.format }),
        count: Math.max(1, Math.floor(Number(request.count) || 1)),
        ...(request.background ? { background: request.background } : {}),
        ...(request.quality ? { quality: request.quality } : {}),
        ...(request.inputFidelity ? { inputFidelity: request.inputFidelity } : {}),
        ...(request.layerDecomposition ? { layerDecomposition: true } : {}),
        ...(request.optimizePrompt ? { optimizePrompt: request.optimizePrompt } : {}),
        ...(request.parameters && Object.keys(request.parameters).length ? { parameters: request.parameters } : {}),
        ...(request.edit ? { edit: request.edit } : {}),
        ...referencePayload,
        // 服务端会按这个目录把图片直接写进工作区（和视频同一套），浏览器不再自己下载。
        outputDirectory: request.outputDirectory || `${request.directory}/assets`,
        requestId: clientRequestId,
        idempotencyKey: clientRequestId,
        async: true,
      }, signal);
    } catch (error) {
      const active = String((error as { activeRequestId?: string }).activeRequestId || "");
      if (active) await confirmMediaTask(request, active, true);
      else {
        const status = Number((error as { status?: number }).status);
        if (status >= 400 && status < 500 && status !== 408) {
          request.onStatus?.("failed");
          throw error;
        }
      }
      throw await interruptedTask(error, active || clientRequestId, request, signal);
    }
    await confirmMediaTask(request, String(payload.requestId || clientRequestId), String(payload.requestId || clientRequestId) !== clientRequestId);
    return waitForImageResult(String(payload.requestId || clientRequestId), request, signal, payload);
  }

  async function findImageTask(outputDirectory: string, signal?: AbortSignal): Promise<string> {
    const payload = await pollJson(`./api/imagine/generation/node?outputDirectory=${encodeURIComponent(outputDirectory)}`, signal);
    return mediaTaskId(payload);
  }

  async function resumeImage(requestId: string, request: Pick<NodeImageRequest, "outputDirectory" | "outputDirectories" | "onStatus" | "shouldCancel">, signal?: AbortSignal): Promise<NodeImageResult[]> {
    let payload: Record<string, unknown>;
    try { payload = await pollTask(`./api/imagine/generation/${encodeURIComponent(requestId)}`, signal, request.onStatus); }
    catch (error) { throw await interruptedTask(error, requestId, request, signal); }
    return waitForImageResult(requestId, request, signal, payload);
  }

  async function waitForImageResult(requestId: string, request: Pick<NodeImageRequest, "outputDirectory" | "outputDirectories" | "onStatus" | "shouldCancel">, signal: AbortSignal | undefined, payload: Record<string, unknown>): Promise<NodeImageResult[]> {
    const files = getFiles();
    const accessToken = String(payload.accessToken || "");
    let status = payload;
    try {
      let images: { url?: string; path?: string; mime?: string }[] = [];
      while (true) {
        signal?.throwIfAborted();
        const state = String(status.status || "");
        request.onStatus?.(status.submissionUncertain ? "confirming" : state, progressValue(status.progress), (state === "saving" || ["doubao-local", "dola-local"].includes(String(status.route))) ? String(status.error || "") : "");
        publishBalance(status);
        if (state === "succeeded" || !state && Array.isArray(status.images)) {
          images = Array.isArray(status.images) ? status.images : [];
          break;
        }
        if (state === "cancelled") throw cancelledResult(status);
        if (["failed", "expired"].includes(state)) throw Object.assign(new Error(String(status.error || translate("图片生成失败"))), { errorExplanation: status.errorExplanation, requestId, csrf });
        await wait(Number(status.pollAfterMs) || 1000, signal);
        status = await pollTask(`./api/imagine/generation/${encodeURIComponent(requestId)}${accessToken ? `?access=${encodeURIComponent(accessToken)}` : ""}`, signal, request.onStatus);
      }
      const available = images.filter((item): item is { url: string; path?: string; mime?: string } => Boolean(item?.url));
      if (!available.length) throw new Error(translate("生成服务没有返回图片"));
      request.onStatus?.("saving");
      const results: NodeImageResult[] = [];
      for (const [index, item] of available.entries()) {
        const mimeType = item.mime || "image/png";
        const directory = request.outputDirectories?.[index] || request.outputDirectory;
        const path = item.path || await persistMedia(files, directory, item.url, mimeType, "png");
        results.push({ path, mimeType, mediaType: "image" });
      }
      signal?.throwIfAborted();
      return results;
    } catch (error) {
      throw await interruptedTask(error, requestId, request, signal, accessToken);
    }
  }

  async function estimateImage(request: Omit<NodeImageRequest, "directory" | "onStatus">, signal?: AbortSignal): Promise<NodeCreditEstimate> {
    if (['doubao-local', 'dola-local'].includes(request.providerId)) {
      if (request.edit) throw new Error(translate('当前本机路由不支持局部重绘'));
      return requestJson('./api/imagine/estimate', { providerId: request.providerId, model: request.modelId, size: 'auto' }, signal) as Promise<NodeCreditEstimate>;
    }
    const models = await loadMediaModels();
    const model = models.find(item => item.modelId === request.modelId);
    const files = getFiles();
    // Quote and submission use the same original-file descriptors and checks.
    const referencePayload = await imageReferencePayload(files, request, model);
    const size = pickSize(model, request.size, request.ratio || ratioOf(model, request.size));
    return requestJson("./api/imagine/estimate", {
      model: request.modelId,
      prompt: request.prompt,
      size: size || undefined,
      ...(request.ratio ? { ratio: request.ratio } : {}),
      ...(request.format ? { format: request.format } : {}),
      count: Math.max(1, Math.floor(Number(request.count) || 1)),
      ...(request.background ? { background: request.background } : {}),
      ...(request.quality ? { quality: request.quality } : {}),
      ...(request.inputFidelity ? { inputFidelity: request.inputFidelity } : {}),
      ...(request.layerDecomposition ? { layerDecomposition: true } : {}),
      ...(request.optimizePrompt ? { optimizePrompt: request.optimizePrompt } : {}),
      ...(request.parameters && Object.keys(request.parameters).length ? { parameters: request.parameters } : {}),
      ...(request.edit ? { edit: request.edit } : {}),
      ...referencePayload,
    }, signal) as Promise<NodeCreditEstimate>;
  }

  async function generateVideo(request: NodeVideoRequest, signal?: AbortSignal): Promise<NodeVideoResult[]> {
    const localMedia = ['doubao-local', 'dola-local'].includes(request.providerId);
    if (localMedia && (request.videos?.length || request.audios?.length || request.firstFrame || request.lastFrame)) throw new Error(translate('当前本机路由不支持视频、音频或首尾帧参考'));
    const files = getFiles();
    const localReferences = localMedia ? await imageReferencePayload(files, request, (await loadMediaModels()).find(item => item.providerId === request.providerId && item.modelId === request.modelId)) : {};
    if ('references' in localReferences) throw new Error(translate('请先将参考图片保存到本机项目，再使用本机模型生成'));
    // 本地素材换成服务端签发的公网只读地址：上游才能抓取，也不会把大视频塞进 data URL。
    const toReference = (path: string) => /^https?:/i.test(path)
      ? Promise.resolve(path)
      : requestJson("./api/imagine/reference-url", { path }).then(payload => String(payload.url || ""));
    const images = localMedia ? [] : await Promise.all((request.images || []).map(item => toReference(item.path)));
    // Keep the two frame slots separate. Filtering the pair first makes a
    // lone last-frame reference slide into the first-frame slot, which changes
    // the meaning of optional-tail-frame requests for every upstream.
    const firstFrame = request.firstFrame ? await toReference(request.firstFrame.path) : "";
    const lastFrame = request.lastFrame ? await toReference(request.lastFrame.path) : "";
    const videos = await Promise.all((request.videos || []).map(item => toReference(item.path)));
    const audios = await Promise.all((request.audios || []).map(item => toReference(item.path)));
    // 参考视频按输入时长计费：本地文件在浏览器里量时长，只用于计费，不发给上游。
    const measuredVideoSeconds = (request.videos || []).length
      ? await Promise.all((request.videos || []).map(item => mediaDurationSeconds(files.url?.(item.path) || item.path)))
      : [];
    if (measuredVideoSeconds.some(seconds => seconds <= 0)) throw new Error(translate("无法读取参考视频的真实时长，请确认文件可播放后重试"));
    const videoSeconds = measuredVideoSeconds.reduce((total, seconds) => total + seconds, 0);
    // Preserve the model's declared mode verbatim. Normalising every string
    // other than text/image/edit/extend to "image" changes singleImage and
    // frame requests into mixed references, which makes Ark omit first_frame
    // and makes classic Grok reject an otherwise valid single-image request.
    const mode = Array.isArray(request.mode) ? "image" : request.mode || "text";
    signal?.throwIfAborted();
    const clientRequestId = crypto.randomUUID();
    try {
      await request.onTask?.(clientRequestId);
      signal?.throwIfAborted();
    } catch (error) { request.onStatus?.("failed"); throw error; }
    let payload: Record<string, unknown>;
    try {
      payload = await requestJson("./api/imagine/video", {
        model: request.modelId,
        providerId: request.providerId,
        prompt: request.prompt,
        referenceHistory: request.referenceHistory,
        ...localReferences,
        // The server and each upstream adapter use the declared mode to choose
        // first/last-frame pins and the correct endpoint. Do not collapse
        // singleImage or optional-frame modes into generic mixed references.
        mode,
        duration: request.duration,
        resolution: request.resolution || undefined,
        ratio: request.ratio || undefined,
        generateAudio: request.generateAudio,
        ...(request.returnLastFrame ? { returnLastFrame: true } : {}),
        ...(request.webSearch ? { webSearch: true } : {}),
        // 首尾帧、普通参考图、视频与音频参考都按模型能力上传，服务端再按模型校验。
        firstFrame: firstFrame || undefined,
        lastFrame: lastFrame || undefined,
        // In mixed-reference mode every uploaded image is a reference image.
        // Only single-image/frame modes use the `image` pin; sending images[0]
        // here would silently turn the first reference into a pinned first frame.
        image: firstFrame || (mode === "singleImage" ? images[0] : undefined) || undefined,
        images: images.length ? images : undefined,
        videos: videos.length ? videos : undefined,
        audios: audios.length ? audios : undefined,
        referenceVoices: request.referenceVoices?.length ? request.referenceVoices : (request.voice ? [request.voice] : undefined),
        keyframes: request.keyframes?.length ? request.keyframes : undefined,
        videoSeconds: videoSeconds || undefined,
        // 服务端会按这个目录把成片直接写进工作区，浏览器不必自己下载再回写。
        outputDirectory: request.outputDirectory || `${request.directory}/assets`,
        requestId: clientRequestId,
        idempotencyKey: clientRequestId,
        async: true,
      }, signal);
    } catch (error) {
      const active = String((error as { activeRequestId?: string }).activeRequestId || "");
      if (active) await confirmMediaTask(request, active, true);
      else {
        const status = Number((error as { status?: number }).status);
        if (status >= 400 && status < 500 && status !== 408) {
          request.onStatus?.("failed");
          throw error;
        }
      }
      throw await interruptedTask(error, active || clientRequestId, request, signal);
    }
    await confirmMediaTask(request, String(payload.requestId || clientRequestId), String(payload.requestId || clientRequestId) !== clientRequestId);
    return waitForVideoResult(String(payload.requestId || clientRequestId), request, signal, payload);
  }

  async function findVideoTask(outputDirectory: string): Promise<string> {
    const payload = await pollJson(`./api/imagine/video/node?outputDirectory=${encodeURIComponent(outputDirectory)}`);
    return mediaTaskId(payload);
  }

  async function resumeVideo(requestId: string, request: Pick<NodeVideoRequest, "directory" | "outputDirectory" | "onStatus" | "shouldCancel">, signal?: AbortSignal): Promise<NodeVideoResult[]> {
    let payload: Record<string, unknown>;
    try { payload = await pollTask(`./api/imagine/video/${encodeURIComponent(requestId)}`, signal, request.onStatus); }
    catch (error) { if ((error as { status?: number }).status === 404) request.onStatus?.("failed"); throw await interruptedTask(error, requestId, request, signal); }
    return waitForVideoResult(requestId, request, signal, payload);
  }

  async function waitForVideoResult(requestId: string, request: Pick<NodeVideoRequest, "directory" | "outputDirectory" | "onStatus" | "shouldCancel">, signal: AbortSignal | undefined, payload: Record<string, unknown>): Promise<NodeVideoResult[]> {
    request.onStatus?.(String(payload.status || "queued"), progressValue(payload.progress), payload.status === "saving" ? String(payload.error || "") : "");
    const accessToken = String(payload.accessToken || "");
    let status = payload;
    try {
      while (true) {
        signal?.throwIfAborted();
        const state = String(status.status || "");
        request.onStatus?.(status.submissionUncertain ? "confirming" : state, progressValue(status.progress), (state === "saving" || ["doubao-local", "dola-local"].includes(String(status.route))) ? String(status.error || "") : "");
        publishBalance(status);
        if (state === "succeeded") {
          const video = status.video as { url?: string; mime?: string; metadata?: { workspacePath?: string } } | undefined;
          if (!video?.url) throw new Error(translate("生成服务没有返回视频"));
          request.onStatus?.("saving");
          const mimeType = video.mime || "video/mp4";
          let path = String(video.metadata?.workspacePath || "");
          // Prefer the authenticated server restore path; never submit another generation.
          while (!path) {
            signal?.throwIfAborted();
            try {
              const restored = await requestJson(`./api/imagine/generation/${encodeURIComponent(requestId)}/restore`, {}, signal);
              path = String(restored.path || "");
            } catch (error) {
              const status = Number((error as { status?: number }).status);
              if (status === 410) request.onStatus?.("expired");
              if (signal?.aborted || (error as { scopeChanged?: boolean }).scopeChanged || [401, 403, 404, 410, 422].includes(status)) throw error;
            }
            if (!path) await wait(5000, signal);
          }
          if (!path) throw new Error(translate("生成服务没有返回视频"));
          return [{ path, mimeType, mediaType: "video" }];
        }
        if (state === "cancelled") throw cancelledResult(status);
        if (["failed", "expired"].includes(state)) throw Object.assign(new Error(String(status.error || translate("视频生成失败"))), { errorExplanation: status.errorExplanation, requestId, csrf });
        await wait(Number(status.pollAfterMs) || 1500, signal);
        status = await pollTask(`./api/imagine/video/${encodeURIComponent(requestId)}${accessToken ? `?access=${encodeURIComponent(accessToken)}` : ""}`, signal, request.onStatus);
      }
    } catch (error) {
      throw await interruptedTask(error, requestId, request, signal, accessToken);
    }
  }

  async function estimateVideo(request: Omit<NodeVideoRequest, "directory" | "onStatus">, signal?: AbortSignal): Promise<NodeCreditEstimate> {
    if (['doubao-local', 'dola-local'].includes(request.providerId)) {
      if (request.videos?.length || request.audios?.length || request.firstFrame || request.lastFrame) throw new Error(translate('当前本机路由不支持视频、音频或首尾帧参考'));
      return requestJson('./api/imagine/video/estimate', { providerId: request.providerId, model: request.modelId, duration: request.duration, resolution: request.resolution || undefined, ratio: request.ratio || undefined }, signal) as Promise<NodeCreditEstimate>;
    }
    const toReference = (path: string) => /^https?:/i.test(path)
      ? Promise.resolve(path)
      : requestJson("./api/imagine/reference-url", { path }).then(payload => String(payload.url || ""));
    const images = await Promise.all((request.images || []).map(item => toReference(item.path)));
    const videos = await Promise.all((request.videos || []).map(item => toReference(item.path)));
    const audios = await Promise.all((request.audios || []).map(item => toReference(item.path)));
    const firstFrame = request.firstFrame ? await toReference(request.firstFrame.path) : "";
    const lastFrame = request.lastFrame ? await toReference(request.lastFrame.path) : "";
    const mode = Array.isArray(request.mode) ? "image" : request.mode || "text";
    return requestJson("./api/imagine/video/estimate", {
      model: request.modelId,
      prompt: request.prompt,
      mode,
      duration: request.duration,
      resolution: request.resolution || undefined,
      ratio: request.ratio || undefined,
      generateAudio: request.generateAudio,
      ...(request.returnLastFrame ? { returnLastFrame: true } : {}),
      ...(request.webSearch ? { webSearch: true } : {}),
      firstFrame: firstFrame || undefined,
      lastFrame: lastFrame || undefined,
      image: firstFrame || (mode === "singleImage" ? images[0] : undefined) || undefined,
      images: images.length ? images : undefined,
      videos: videos.length ? videos : undefined,
      audios: audios.length ? audios : undefined,
      videoSeconds: undefined,
    }, signal) as Promise<NodeCreditEstimate>;
  }

  async function getModels(options: { tools?: boolean } = {}): Promise<NodeAiModel[]> {
    const scope = captureWorkspaceScope();
    const config = await loadConfig();
    const providers = await loadUserProviders().catch(() => []);
    const local = window.miaoDesktop && !options.tools ? await requestData<NodeAiModel[]>('./api/desktop/local-text/models') : [];
    assertWorkspaceScope(scope);
    const official = config.textEnabled === false ? [] : (config.textModels || []).filter(model => model.configured !== false);
    const preferred = official.find(model => model.id === config.defaultTextModel);
    return [
      ...(preferred ? [preferred, ...official.filter(model => model !== preferred)] : official)
        .map((model): NodeAiModel => ({
          providerId: "miaoimg",
          providerLabel: "妙图",
          modelId: model.id,
          label: model.label,
          protocol: (model.protocol as NodeAiModel["protocol"]) || "openai-completions",
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
        })),
      ...providers.flatMap(provider => provider.models.map((model): NodeAiModel => ({
        providerId: provider.id,
        providerLabel: provider.label,
        modelId: model.id,
        label: model.label,
        protocol: (provider.protocol as NodeAiModel["protocol"]) || "openai-completions",
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
      }))),
      ...local,
    ];
  }

  async function generate(request: NodeAiRequest): Promise<NodeAiResult> {
    if (['doubao-local', 'dola-local'].includes(request.providerId)) {
      const recovering = request.taskId !== undefined;
      if (recovering && (typeof request.taskId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(request.taskId))) throw new Error(translate('原文本任务编号无效，请检查原任务记录；尚未重新生成。'));
      let requestId = request.taskId || crypto.randomUUID();
      let terminal = false;
      const finish = () => { terminal = true; request.onTaskFinished?.(requestId); };
      async function readOriginal() {
        try { return await pollTask(`./api/imagine/generation/${encodeURIComponent(requestId)}`, request.signal); }
        catch (error) {
          if (Number((error as { status?: number }).status) !== 404 || request.signal?.aborted || (error as { scopeChanged?: boolean }).scopeChanged) throw error;
          // A client ID can precede admission. Only this node's authoritative
          // directory lookup may adopt another ID or prove there was no job.
          if (!request.outputDirectory) throw error;
          const found = mediaTaskId(await pollJson(`./api/imagine/generation/node?kind=text&providerId=${encodeURIComponent(request.providerId)}&model=${encodeURIComponent(request.modelId)}&outputDirectory=${encodeURIComponent(request.outputDirectory)}`, request.signal));
          if (!found) { finish(); throw new Error(translate('原文本任务不存在，尚未重新生成；请确认后再次生成。')); }
          if (found === requestId) throw error;
          requestId = found;
          await confirmMediaTask(request, requestId, true);
          return pollTask(`./api/imagine/generation/${encodeURIComponent(requestId)}`, request.signal);
        }
      }
      let prompt = '';
      if (recovering) await confirmMediaTask(request, requestId, true);
      else {
        if (request.tools?.length) throw new Error(translate('本机网页登录模型暂不提供 Agent 工具调用，请选择其他文本模型'));
        if (request.references?.some(item => item.dataType !== 'STRING')) throw new Error(translate('当前本机文本路由只支持文字引用，请移除图片或视频引用'));
        prompt = [request.systemPrompt || '', request.prompt.trim(), ...(request.references || []).map(item => String(item.value || '').trim())].filter(Boolean).join('\n\n');
        request.signal?.throwIfAborted();
        // A failed binding save is still before dispatch and must not send.
        await request.onTask?.(requestId, false);
        request.signal?.throwIfAborted();
      }
      try {
        let status: Record<string, unknown>;
        if (recovering) status = await readOriginal();
        else {
          try {
            status = await requestJson('./api/desktop/local-text', { providerId: request.providerId, model: request.modelId, prompt,
              outputDirectory: request.outputDirectory || 'local-text', requestId }, request.signal);
          } catch (error) {
            const code = Number((error as { status?: number }).status);
            // 409 can also arrive after local admission/account retirement.
            // Keep its ID until a GET proves the original task's outcome.
            if (!(error as { scopeChanged?: boolean }).scopeChanged && [400, 401, 402, 403, 404, 422].includes(code)) finish();
            throw error;
          }
        }
        for (;;) {
          request.signal?.throwIfAborted();
          if (status.requestId !== requestId || status.route !== request.providerId || status.model !== request.modelId
            || !['submitting', 'confirming', 'queued', 'running', 'saving', 'succeeded', 'failed', 'cancelled', 'expired'].includes(String(status.status))) {
            throw new Error(translate('原文本任务回执不完整，请继续取回原任务。'));
          }
          if (status.status === 'succeeded') {
            if (typeof status.text !== 'string' || !status.text.trim()) throw new Error(translate('原文本任务尚未返回完整正文，请继续取回。'));
            // The caller owns document CAS and clears its binding only after
            // those bytes are durable. Reading a result is not delivery.
            request.onEvent?.({ type: 'text', delta: status.text });
            return { text: status.text, requestId };
          }
          if (['failed', 'cancelled', 'expired'].includes(String(status.status))) {
            finish();
            throw Object.assign(new Error(String(status.error || translate('本机文本生成未完成'))), status.status === 'cancelled' ? { name: 'AbortError', generationCancelled: true } : {});
          }
          request.onEvent?.({ type: 'status', message: String(status.error || translate('正在等待本机账户返回文本…')) });
          await wait(2000, request.signal);
          status = await pollTask(`./api/imagine/generation/${encodeURIComponent(requestId)}`, request.signal);
        }
      } catch (error) {
        throw terminal ? error : pendingMediaTaskError(error, requestId);
      }
    }
    const references = (request.references || [])
      .map((item, index) => item.dataType === "STRING" && String(item.value || "").trim() ? `{{ref ${index + 1}}} ${String(item.value).trim()}` : "")
      .filter(Boolean);
    const prompt = [request.prompt.trim(), ...references].filter(Boolean).join("\n\n");
    {
      // 文本节点和带工具节点共用流式模型回合，输出预算来自所选模型。
      const definitions = request.tools || [];
      const controller = new AbortController();
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
      const headers = { "Content-Type": "application/json", "x-miaoimg-workspace": "1", "Accept-Language": document.documentElement.lang || "zh-CN" };
      const tools = new Map(definitions.map(tool => [tool.name, tool]));
      const blocks = new Map<string, string>();
      const handled = new Set<string>();
      const started = new Set<string>();
      try {
        const response = await fetch("./api/agent", {
          method: "POST", headers, signal,
          body: JSON.stringify({ providerId: request.providerId, modelId: request.modelId, prompt,
            nodeTurn: { mode: definitions.length ? undefined : 'text', references: request.references || [], systemPrompt: request.systemPrompt || '你是妙图的文本创作助手。根据用户要求和参考素材直接提供完整的文本内容，保持用户指定的语言、格式与长度。', tools: definitions.map(({ name, description, parameters }) => ({ name, description, parameters })) } }),
        });
        for await (const event of readAgentEvents(response, signal)) {
          if (event.type === "status") request.onEvent?.({ type: "status", message: translate(event.message) });
          if (event.type === "accepted") request.onEvent?.({ type: "status", message: translate(definitions.length ? "Agent 已接收，正在规划动画…" : "正在生成文本…") });
          if (event.type === "compaction") request.onEvent?.({ type: "status", message: translate(definitions.length ? event.active ? "正在整理场景上下文…" : "继续生成动画…" : event.active ? "正在整理文本上下文…" : "继续生成文本…") });
          if (event.type === "text" || event.type === "thinking") {
            if (event.type === "text") blocks.set(event.blockId, event.content ?? (blocks.get(event.blockId) || "") + (event.delta || ""));
            if (event.delta) request.onEvent?.({ type: event.type === "text" ? "text" : "reasoning", delta: event.delta });
          }
          if (event.type === "tool") {
            if (event.tool.status === "running" && !started.has(event.tool.id)) {
              started.add(event.tool.id);
              request.onEvent?.({ type: "toolStart", id: event.tool.id, name: event.tool.name, args: event.tool.args });
            } else if (event.tool.status !== "running") {
              request.onEvent?.({ type: "toolEnd", id: event.tool.id, name: event.tool.name, result: event.tool.result, isError: event.tool.status === "error" });
            }
          }
          if (event.type === "canvasCall") {
            if (handled.has(event.callId)) throw new Error(translate("收到重复的工具调用，请重试"));
            handled.add(event.callId);
            let payload: { callId: string; result?: unknown; error?: string } = { callId: event.callId };
            try {
              signal.throwIfAborted();
              const tool = tools.get(event.name);
              if (!tool) throw new Error(translate("工具名称与本轮草稿不一致，请重试"));
              payload.result = await tool.execute(event.args, signal) ?? null;
            } catch (error) {
              payload.error = error instanceof Error ? error.message : translate("工具执行失败，请重试");
            }
            signal.throwIfAborted();
            const receipt = await fetch("./api/agent/canvasResult", { method: "POST", headers, signal, body: JSON.stringify(payload) });
            if (!receipt.ok) {
              const error = await receipt.json().catch(() => ({}));
              throw new Error(error.message || translate("工具结果回传失败，请重试"));
            }
          }
        }
        return { text: [...blocks.values()].join("\n") };
      } finally {
        controller.abort();
      }
    }
  }

  return { getMediaModels, getModels, generate, generateImage, resumeImage, findImageTask, estimateImage, generateVideo, resumeVideo, findVideoTask, estimateVideo };
}
