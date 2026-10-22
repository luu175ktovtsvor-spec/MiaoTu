import { usesCanvasHost } from '../../../../../server/canvas-document.ts';
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";
import type { NodeTypesObject } from "@vue-flow/core";
import { installExtendedNodeHost } from './nodeHost';

type NodeComponent = Exclude<NodeTypesObject[string], string>;

const components = new Map<string, NodeComponent>();
const requests = new Map<string, { promise: Promise<NodeComponent>; force: boolean }>();
const scriptQueues = new Map<string, Promise<void>>();
let scopeBinding = { scope: captureWorkspaceScope(), controller: new AbortController() };
type NodeScope = typeof scopeBinding;

function nodeScope() {
  const scope = captureWorkspaceScope();
  if (scope.owner !== scopeBinding.scope.owner || scope.project !== scopeBinding.scope.project) {
    scopeBinding.controller.abort();
    scopeBinding = { scope, controller: new AbortController() };
    components.clear();
    requests.clear();
    catalog = undefined;
    catalogRequest = undefined;
    catalogRevision++;
  }
  return scopeBinding;
}

function assertNodeScope(binding: NodeScope) {
  nodeScope();
  assertWorkspaceScope(binding.scope);
  binding.controller.signal.throwIfAborted();
}

export function loadNodeComponent(name: string, url: string, force = false): Promise<NodeComponent> {
  const scope = nodeScope();
  const scriptUrl = new URL(url, window.location.href);
  if (!/^[a-z][a-zA-Z0-9]*$/.test(name) || scriptUrl.origin !== window.location.origin
    || scriptUrl.pathname !== "/api/nodes/files" || scriptUrl.searchParams.get("name") !== name) throw new Error("节点脚本地址无效");
  const pending = requests.get(name);
  if (pending && (!force || pending.force)) return pending.promise;
  const nodeWindow = window as typeof window & { miaoimgNodes?: NodeTypesObject };
  // 全局导出只用于本次脚本交接，不能作为跨账号、项目的组件缓存。
  const cached = components.get(name);
  if (!force && cached) return Promise.resolve(cached);
  components.delete(name);
  if (force) scriptUrl.searchParams.set("reload", crypto.randomUUID());
  // 同名脚本串行交接全局导出；更新请求在已有普通加载结束后取回新版。
  // 节点产物把 tiptap 外置到 miaoimgTiptapHost，脚本执行前宿主必须先挂出这些全局。
  const request = (scriptQueues.get(name) ?? Promise.resolve()).catch(() => {}).then(async () => {
    assertNodeScope(scope);
    components.delete(name);
    const signal = AbortSignal.any([scope.controller.signal, AbortSignal.timeout(30_000)]);
    const response = await fetch(scriptUrl.href, { headers: { "x-miaoimg-workspace": "1" }, cache: "no-store", signal });
    try { assertNodeScope(scope); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`节点脚本加载失败（HTTP ${response.status}）`);
    }
    const code = await response.text();
    assertNodeScope(scope);
    await installExtendedNodeHost();
    assertNodeScope(scope);
    if (usesCanvasHost(code, "miaoimgTiptapHost")) await import("@/lib/tiptapHost");
    assertNodeScope(scope);
    signal.throwIfAborted();
    return new Promise<NodeComponent>((resolve, reject) => {
      delete nodeWindow.miaoimgNodes?.[name];
      const script = document.createElement("script");
      // 执行带项目身份取回的同一份字节，避免 script 再次请求时丢失项目头。
      const source = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      script.src = source;
      const cleanup = () => {
        script.onload = script.onerror = null;
        script.remove();
        URL.revokeObjectURL(source);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      script.onload = () => {
        cleanup();
        try {
          assertNodeScope(scope);
          const component = nodeWindow.miaoimgNodes?.[name];
          if (!Object.hasOwn(nodeWindow.miaoimgNodes ?? {}, name) || !component || (typeof component !== "object" && typeof component !== "function")) throw new Error(`节点脚本未导出 ${name} 组件`);
          resolve(component);
        } catch (error) { reject(error); }
      };
      script.onerror = () => {
        cleanup();
        delete nodeWindow.miaoimgNodes?.[name];
        reject(new Error("节点脚本加载失败"));
      };
      if (signal.aborted) { abort(); return; }
      try { document.head.append(script); }
      catch (error) { cleanup(); reject(error); }
    });
  }).then(component => {
    assertNodeScope(scope);
    components.set(name, component);
    return component;
  }).finally(() => { if (requests.get(name)?.promise === request) requests.delete(name); });
  requests.set(name, { promise: request, force });
  const queued = request.then(() => {}, () => {});
  scriptQueues.set(name, queued);
  void queued.then(() => { if (scriptQueues.get(name) === queued) scriptQueues.delete(name); });
  return request;
}

// 同一账号/项目的画布复用短期节点目录，切换时不为每个实例重新请求。
type NodeCatalog = { code: number; data: { name: string; displayName: string; url: string; enabled?: boolean; config?: Record<string, unknown> }[] };
let catalog: { key: string; value: NodeCatalog; expires: number } | undefined;
let catalogRequest: { key: string; promise: Promise<NodeCatalog> } | undefined;
let catalogRevision = 0;
export function loadNodeCatalog(refresh = false): Promise<NodeCatalog> {
  const scope = nodeScope();
  const key = JSON.stringify(scope.scope);
  if (refresh) { catalogRevision++; catalog = undefined; }
  if (catalogRequest?.key === key) return catalogRequest.promise;
  if (catalog?.key === key && catalog.expires > Date.now()) return Promise.resolve(catalog.value);
  // 安装/配置更新期间的刷新使旧请求失效；等待者共同取得最新目录。
  async function readCatalog(): Promise<NodeCatalog> {
    assertNodeScope(scope);
    const requestedRevision = catalogRevision;
    try {
      const response = await fetch("/api/nodes/get", {
        headers: { "x-miaoimg-workspace": "1" }, cache: "no-store",
        signal: AbortSignal.any([scope.controller.signal, AbortSignal.timeout(30_000)]),
      });
      try { assertNodeScope(scope); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      if (requestedRevision !== catalogRevision) {
        await response.body?.cancel().catch(() => {});
        return readCatalog();
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`节点列表加载失败（HTTP ${response.status}）`);
      }
      const data = await response.json() as NodeCatalog;
      assertNodeScope(scope);
      if (requestedRevision !== catalogRevision) return readCatalog();
      if (data?.code !== 200 || !Array.isArray(data.data)) throw new Error("节点列表格式错误");
      catalog = { key, value: data, expires: Date.now() + 30000 };
      return data;
    } catch (error) {
      assertNodeScope(scope);
      if (requestedRevision !== catalogRevision) return readCatalog();
      throw error;
    }
  }
  const promise = readCatalog().finally(() => { if (catalogRequest?.promise === promise) catalogRequest = undefined; });
  catalogRequest = { key, promise };
  return promise;
}
