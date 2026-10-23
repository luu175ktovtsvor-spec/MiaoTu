// 自定义文本供应商的客户端缓存。桌面版把配置保存在本机当前工作区，
// 页面只拿到脱敏后的列表（hasKey，不含 Key）。
import { ref } from "vue";
import { assertWorkspaceScope, captureWorkspaceScope, subscribeWorkspaceScope, workspaceHeaders } from './workspaceRemote';

export type ProviderModelEntry = {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
  compat?: Record<string, string | number | boolean>;
};
export type UserProvider = { id: string; label: string; apiUrl: string; protocol: string; compat?: Record<string, string | number | boolean>; models: ProviderModelEntry[]; hasKey: boolean };

export const PROVIDER_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

const providers = ref<UserProvider[]>([]);
let loaded = false;
let binding = { scope: captureWorkspaceScope(), controller: new AbortController() };
type Binding = typeof binding;
let revision = 0;
let loading: { controller: AbortController; promise: Promise<UserProvider[]> } | undefined;

function invalidateCatalog() {
  revision++;
  loaded = false;
  loading?.controller.abort();
  loading = undefined;
}
const unsubscribe = subscribeWorkspaceScope(() => {
  binding.controller.abort();
  binding = { scope: captureWorkspaceScope(), controller: new AbortController() };
  invalidateCatalog();
  providers.value = [];
});
function assertBinding(current: Binding) {
  assertWorkspaceScope(current.scope);
  current.controller.signal.throwIfAborted();
}

async function request(path: string, init: RequestInit = {}, current = binding) {
  assertBinding(current);
  init.signal?.throwIfAborted();
  const response = await fetch(path, {
    credentials: "same-origin", cache: 'no-store',
    ...init,
    signal: AbortSignal.any([current.controller.signal, ...(init.signal ? [init.signal] : [])]),
    headers: { ...workspaceHeaders(current.scope.owner), "x-miaoimg-workspace": "1", ...(init.headers || {}) },
  });
  try { assertBinding(current); init.signal?.throwIfAborted(); }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  const data = await response.json().catch(() => undefined);
  assertBinding(current);
  init.signal?.throwIfAborted();
  if (!response.ok || data?.ok === false) throw new Error(data?.error || data?.message || "请求失败（" + response.status + "）");
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok !== true) throw new Error('供应商响应格式无效，请重试');
  return data;
}

export function userProviders() {
  return providers;
}

export async function loadUserProviders(force = false): Promise<UserProvider[]> {
  const current = binding;
  assertBinding(current);
  if (loaded && !force) return providers.value;
  if (loading) return loading.promise;
  const requestedRevision = revision;
  const pending = { controller: new AbortController(), promise: undefined as unknown as Promise<UserProvider[]> };
  loading = pending;
  pending.promise = (async () => {
    try {
      const data = await request("./api/imagine/providers", { signal: pending.controller.signal }, current);
      assertBinding(current);
      if (requestedRevision !== revision) throw new Error('供应商列表已更新，请重新读取');
      if (!Array.isArray(data.providers)) throw new Error('供应商列表格式无效，请重试');
      providers.value = data.providers;
      loaded = true;
      return providers.value;
    } finally {
      if (loading === pending) loading = undefined;
    }
  })();
  return pending.promise;
}

export function invalidateUserProviders() {
  const current = binding;
  invalidateCatalog();
  return loadUserProviders(true).catch(() => { assertBinding(current); return providers.value; });
}

export async function saveUserProvider(payload: { id: string; label: string; apiUrl: string; protocol: string; apiKey?: string; compat?: Record<string, string | number | boolean>; models: ProviderModelEntry[] }) {
  const current = binding;
  const data = await request("./api/imagine/providers", { method: "POST", body: JSON.stringify(payload) }, current);
  assertBinding(current);
  invalidateCatalog();
  await loadUserProviders(true);
  assertBinding(current);
  return data.provider as UserProvider;
}

export async function removeUserProvider(id: string) {
  const current = binding;
  const data = await request("./api/imagine/providers", { method: "POST", body: JSON.stringify({ operation: "remove", id }) }, current);
  assertBinding(current);
  invalidateCatalog();
  await loadUserProviders(true);
  assertBinding(current);
  return data;
}

export async function fetchProviderModels(payload: { id?: string; apiUrl?: string; protocol?: string; apiKey?: string }): Promise<ProviderModelEntry[]> {
  const data = await request("./api/imagine/providers/models", { method: "POST", body: JSON.stringify(payload) });
  if (!Array.isArray(data.models)) throw new Error("模型列表格式不受支持");
  return data.models;
}

import.meta.hot?.dispose(() => { unsubscribe(); binding.controller.abort(); invalidateCatalog(); providers.value = []; });
