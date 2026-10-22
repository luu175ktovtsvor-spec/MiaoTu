import { usesCanvasHost } from '../../../../../../server/canvas-document.ts';
// 文件扩展运行时：登记宿主全局、拉取扩展清单、按资源挑候选、按需加载脚本。
// 同一份文档可以被多个视图打开，扩展脚本按 id 串行执行，避免后到的旧请求覆盖新导出。
import { computed, shallowRef, toRaw } from "vue";
import { assertWorkspaceScope, captureWorkspaceScope, workspaceDirectory } from "@/lib/workspaceRemote";
import { saveSettings, settings } from "@/stores/settings";
import { installExtHost } from "./host";
import { installExtendedNodeHost } from '../nodeHost';
import { builtinComponents } from "./builtin";
import { extFiles } from "./extFiles";
import { writeClipboardText } from "@/lib/clipboard";
import { useWorkspaceContentFiles as useWorkspaceFiles } from "@/lib/workspaceFiles";
import { defineExt, type ExtContext, type ExtDefinition, type ExtResource } from "./types";
import type { WorkspaceFileCopier } from '@/pages/workspace/canvasFiles';

export type InstalledExtension = Omit<ExtDefinition, "load"> & {
  name: string;
  enabled: boolean;
  url: string;
  version: string;
  builtin: boolean;
  author?: string;
  readme?: string;
  loadError?: string;
  config: Record<string, unknown>;
};

// 默认打开方式：后缀（画布节点用 canvasNode）→ 扩展 ID，存在浏览器本地设置里。
const ASSOCIATION_KEY = "fileExtensions";

export const extensionAssociations = computed<Record<string, string>>(() => {
  const value = settings.value[ASSOCIATION_KEY];
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
});

export async function setExtensionAssociation(suffix: string, id?: string) {
  const scope = extensionScope();
  if (id) {
    const extensions = await listExtensions();
    if (!extensions.some(extension => extension.id === id && extension.enabled && !extension.loadError
      && (suffix === "canvasNode" ? extension.resourceKind === "canvasNode" : extension.resourceKind === "file" && extension.extensions.includes(suffix)))) {
      throw new Error("所选扩展未启用或不支持此文件类型");
    }
  }
  await saveSettings(current => {
    assertExtensionScope(scope);
    const previous = current[ASSOCIATION_KEY];
    const associations = previous && typeof previous === "object" && !Array.isArray(previous) ? { ...previous } : {};
    if (id) Object.assign(associations, { [suffix]: id });
    else Reflect.deleteProperty(associations, suffix);
    return { [ASSOCIATION_KEY]: associations };
  });
}

const requests = new Map<string, Promise<ExtDefinition>>();
const scriptQueues = new Map<string, Promise<unknown>>();
const configSaves = new Map<string, Promise<void>>();
const definitions = shallowRef<InstalledExtension[]>([]);
let installed: Promise<InstalledExtension[]> | undefined;
let revision = 0;
let configRevision = 0;
const configChanges = new Map<string, { revision: number; config: Record<string, unknown> }>();
let scopeBinding = { scope: captureWorkspaceScope(), controller: new AbortController() };
type ExtensionScope = typeof scopeBinding;

function extensionScope() {
  const scope = captureWorkspaceScope();
  if (scope.owner !== scopeBinding.scope.owner || scope.project !== scopeBinding.scope.project) {
    scopeBinding.controller.abort();
    scopeBinding = { scope, controller: new AbortController() };
    invalidateExtensions();
    definitions.value = [];
    configChanges.clear();
    configSaves.clear();
  }
  return scopeBinding;
}

function assertExtensionScope(binding: ExtensionScope) {
  extensionScope();
  assertWorkspaceScope(binding.scope);
  binding.controller.signal.throwIfAborted();
}

async function extensionRequest(path: string, scope: ExtensionScope, init: RequestInit = {}) {
  assertExtensionScope(scope);
  init.signal?.throwIfAborted();
  const response = await fetch(path, {
    ...init, credentials: "same-origin", signal: AbortSignal.any([scope.controller.signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
    headers: { "x-miaoimg-workspace": "1", "content-type": "application/json", ...init.headers },
  });
  try { assertExtensionScope(scope); init.signal?.throwIfAborted(); }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  const data = await response.json().catch(() => undefined);
  assertExtensionScope(scope);
  init.signal?.throwIfAborted();
  if (!response.ok) throw new Error(data?.error || data?.message || `扩展请求失败（HTTP ${response.status}）`);
  if (data?.code !== 200 || !Object.hasOwn(data, "data")) throw new Error("扩展操作结果尚未确认，请核对后再继续");
  return data.data;
}

function invalidateExtensions() {
  installed = undefined;
  requests.clear();
  revision++;
}

// 只加载扩展脚本，供 resolveExtension 使用；内置扩展的组件已经编译进包里，不走脚本。
export function listExtensions(refresh = false): Promise<InstalledExtension[]> {
  const scope = extensionScope();
  if (refresh) invalidateExtensions();
  if (!installed) {
    const requestedRevision = revision;
    const requestedConfigRevision = configRevision;
    installed = extensionRequest("/api/ext/list", scope)
      .then((data): InstalledExtension[] | Promise<InstalledExtension[]> => {
        assertExtensionScope(scope);
        if (requestedRevision !== revision) return listExtensions();
        if (!Array.isArray(data)) throw new Error("文件扩展列表格式错误");
        definitions.value = data.map(extension => {
          const change = configChanges.get(extension.id);
          return change && change.revision > requestedConfigRevision ? { ...extension, config: change.config } : extension;
        });
        for (const [id, change] of configChanges) if (change.revision <= requestedConfigRevision) configChanges.delete(id);
        return definitions.value;
      }).catch(error => {
        assertExtensionScope(scope);
        if (requestedRevision !== revision) return listExtensions();
        installed = undefined;
        throw error;
      });
  }
  return installed.then(() => { assertExtensionScope(scope); return definitions.value; });
}

export function extensionIcon(resource: ExtResource) {
  const candidates = matchingExtensions(resource);
  const key = resource.kind === "canvasNode" ? "canvasNode" : resource.path.split(".").at(-1)!.toLowerCase();
  return (candidates.find(extension => extension.id === extensionAssociations.value[key]) ?? (candidates.length === 1 ? candidates[0] : undefined))?.icon;
}

export function extensionConfig(id: string) {
  extensionScope();
  return definitions.value.find(extension => extension.id === id)?.config ?? configChanges.get(id)?.config ?? {};
}

export function updateExtensionConfig(id: string, config: Record<string, unknown>) {
  extensionScope();
  configChanges.set(id, { revision: ++configRevision, config });
  definitions.value = definitions.value.map(extension => extension.id === id ? { ...extension, config } : extension);
}

export function saveExtensionConfig(name: string, config: Record<string, unknown>, signal?: AbortSignal) {
  const scope = extensionScope();
  const snapshot = structuredClone(toRaw(config));
  const saving = (configSaves.get(name) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const data = await extensionRequest("/api/ext/save", scope, { method: "POST", body: JSON.stringify({ name, config: snapshot }), signal });
    if (data?.name !== name || !data.config || typeof data.config !== "object" || Array.isArray(data.config)) throw new Error("扩展配置保存结果尚未确认，请核对后再继续");
    window.dispatchEvent(new CustomEvent("miaoimg:ext-config-updated", { detail: { name, config: data.config } }));
  });
  configSaves.set(name, saving);
  const clear = () => { if (configSaves.get(name) === saving) configSaves.delete(name); };
  void saving.then(clear, clear);
  return saving;
}

// 用户扩展是 UMD 脚本：先取源码，需要 tiptap 时才加载共享依赖，再注入 <script> 读全局导出。
function loadScript(extension: InstalledExtension, scope: ExtensionScope) {
  const requestedRevision = revision;
  const key = JSON.stringify([extension.id, extension.url, extension.version, requestedRevision]);
  let request = requests.get(key);
  if (!request) {
    request = (scriptQueues.get(extension.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      assertExtensionScope(scope);
      if (requestedRevision !== revision) throw new Error("文件扩展已更新，请重新打开");
      const url = new URL(extension.url, window.location.href);
      if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/ext/")) throw new Error("扩展脚本地址无效");
      url.searchParams.set("revision", String(requestedRevision));
      const signal = AbortSignal.any([scope.controller.signal, AbortSignal.timeout(30_000)]);
      const response = await fetch(url.href, { headers: { "x-miaoimg-workspace": "1" }, cache: "no-store", signal });
      try { assertExtensionScope(scope); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`扩展加载失败：${extension.displayName}（HTTP ${response.status}）`);
      }
      const code = await response.text();
      assertExtensionScope(scope);
      if (usesCanvasHost(code, 'miaoimgNodeHost')) await installExtendedNodeHost();
      assertExtensionScope(scope);
      // tiptap 由宿主提供同一份实例，扩展产物里不会重复打包；用到时才加载。
      if (usesCanvasHost(code, "miaoimgTiptapHost")) await import("@/lib/tiptapHost");
      assertExtensionScope(scope);
      if (requestedRevision !== revision) throw new Error("文件扩展已更新，请重新打开");
      installExtHost();
      return new Promise<ExtDefinition>((resolve, reject) => {
        const script = document.createElement("script");
        // Execute the bytes fetched with the captured project headers. Loading
        // the API URL through a script tag would issue a second, unscoped request.
        const source = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        script.src = source;
        const cleanup = () => { script.remove(); URL.revokeObjectURL(source); signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        script.onload = () => {
          cleanup();
          try {
            assertExtensionScope(scope);
            if (requestedRevision !== revision) throw new Error("文件扩展已更新，请重新打开");
            const definition = window.miaoimgExts?.[extension.id] as ExtDefinition | undefined;
            if (!definition || definition.id !== extension.id) throw new Error("扩展没有导出对应组件");
            resolve(defineExt(definition));
          } catch (error) { reject(error); }
        };
        script.onerror = () => {
          cleanup();
          reject(new Error(`扩展加载失败：${extension.displayName}`));
        };
        if (signal.aborted) { abort(); return; }
        delete window.miaoimgExts?.[extension.id];
        try { document.head.append(script); }
        catch (error) { cleanup(); reject(error); }
      });
    }).catch(error => {
      requests.delete(key);
      throw error;
    });
    const queued = request.then(() => {}, () => {});
    scriptQueues.set(extension.id, queued);
    void queued.then(() => { if (scriptQueues.get(extension.id) === queued) scriptQueues.delete(extension.id); });
    requests.set(key, request);
  }
  return request;
}

function loadDefinition(extension: InstalledExtension, scope: ExtensionScope) {
  assertExtensionScope(scope);
  const component = builtinComponents[extension.id];
  if (component) return Promise.resolve(defineExt({ ...extension, load: component }));
  return loadScript(extension, scope);
}

// 按资源类型和后缀挑候选：画布节点不按后缀匹配。
function matchingExtensions(resource: ExtResource) {
  const scope = extensionScope();
  if (resource.directory !== workspaceDirectory(scope.scope.owner, scope.scope.project)) return [];
  const suffix = resource.path.split(".").at(-1)?.toLowerCase();
  return definitions.value.filter(extension => extension.enabled && !extension.loadError && extension.resourceKind === resource.kind
    && (resource.kind === "canvasNode" || extension.extensions.includes(suffix ?? "")));
}

export async function extensionCandidates(resource: ExtResource) {
  const scope = extensionScope();
  if (resource.directory !== workspaceDirectory(scope.scope.owner, scope.scope.project)) throw new Error("工作区已切换，请重新打开文件");
  await listExtensions();
  assertExtensionScope(scope);
  return matchingExtensions(resource);
}

// 文件树、快速打开、全文搜索要在过滤器里同步问「这个文件有没有编辑器」，
// 这几个入口不改造成异步：清单加载完一次后，这里是上一份快照。
export function currentExtensions() {
  extensionScope();
  return definitions.value;
}

export function candidateExtensions(resource: ExtResource) {
  return matchingExtensions(resource);
}

// 全文搜索只关心哪些后缀是文本，同样按上一份快照同步返回。
export function textExtensions() {
  extensionScope();
  return new Set(definitions.value
    .filter(extension => extension.enabled && !extension.loadError && extension.resourceKind === "file" && extension.text)
    .flatMap(extension => extension.extensions));
}

export async function resolveExtension(resource: ExtResource, id?: string): Promise<ExtDefinition> {
  const scope = extensionScope();
  const candidates = await extensionCandidates(resource);
  assertExtensionScope(scope);
  const extension = id ? candidates.find(item => item.id === id) : candidates[0];
  if (!extension) throw new Error(`尚未启用支持此文件的扩展，请到插件市场安装或启用：${resource.label}`);
  return loadDefinition(extension, scope);
}

// 宿主能力：把面板自己的会话上下文补成扩展契约的完整形状。
// 只补扩展需要的键，正文本、保存状态、定位与画布节点输出仍由面板提供。
export function createExtContext(context: Record<string, unknown>, extensionId: string,
  { copyCanvasFiles, signal }: { copyCanvasFiles?: WorkspaceFileCopier; signal?: AbortSignal } = {}): ExtContext {
  const scope = extensionScope();
  const resource = context.resource as ExtResource;
  if (resource.directory !== workspaceDirectory(scope.scope.owner, scope.scope.project)) throw new Error("工作区已切换，请重新打开文件");
  const files = extFiles(useWorkspaceFiles(resource.directory), { signal, ...(copyCanvasFiles ? {
    async copyCanvasFiles(path: string, target: string, signal?: AbortSignal) {
      assertExtensionScope(scope);
      await copyCanvasFiles(resource.directory, path, target, signal);
      assertExtensionScope(scope);
    },
  } : {}) });
  return new Proxy(context, {
    get(target, key, receiver) {
      if (key === "files") return files;
      // 配置按 id 实时取，设置面板改完立刻生效。
      if (key === "config") { assertExtensionScope(scope); return extensionConfig(extensionId); }
      if (key === "saveConfig") return async (config: Record<string, unknown>) => { assertExtensionScope(scope); await saveExtensionConfig(extensionId, config); };
      if (key === "writeClipboardText") return writeClipboardText;
      // 打开工作区里的另一个文件由面板决定怎么开，这里只广播请求。
      if (key === "openFile") {
        return async (path: string) => {
          assertExtensionScope(scope);
          window.dispatchEvent(new CustomEvent("miaoimg:ext-open-file", { detail: { directory: resource.directory, path } }));
        };
      }
      return Reflect.get(target, key);
    },
    has(target, key) {
      return ["files", "config", "saveConfig", "writeClipboardText", "openFile"].includes(String(key)) || Reflect.has(target, key);
    },
  }) as unknown as ExtContext;
}

function extensionsUpdated() {
  invalidateExtensions();
  void listExtensions().catch(() => {});
}

function configUpdated(event: Event) {
  const detail = (event as CustomEvent<{ name?: unknown; config?: unknown }>).detail;
  if (typeof detail?.name === "string" && detail.config && typeof detail.config === "object" && !Array.isArray(detail.config)) {
    updateExtensionConfig(detail.name, detail.config as Record<string, unknown>);
  }
}

window.addEventListener("miaoimg:ext-updated", extensionsUpdated);
window.addEventListener("miaoimg:ext-config-updated", configUpdated);
import.meta.hot?.dispose(() => {
  window.removeEventListener("miaoimg:ext-updated", extensionsUpdated);
  window.removeEventListener("miaoimg:ext-config-updated", configUpdated);
});

export { extFiles };
