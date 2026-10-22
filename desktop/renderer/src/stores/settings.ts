// 画布设置存储：版式沿用 MiaoImg 的 settings store，
// 持久化改成浏览器本地（妙图的模型由服务端统一配置，客户端没有自己的 Key）。
import { computed, ref, watch } from "vue";
import { invalidateNodeModels } from "@miaoimg/nodes-scaffold/nodeAi";
import { canvasShortcutFields, defaultCanvasShortcuts, getShortcutBindings, isShortcutAllowed, normalizeShortcut, type CanvasShortcuts } from "@/lib/canvasShortcuts";
import { loadUserProviders, userProviders, type ProviderModelEntry, type UserProvider } from "@/lib/providerModels";
import { normalizeLocale as normalizeCanvasLocale } from "@/studio/canvas/i18n";
import { notifyCanvasLanguage } from "@/shellLanguage";
import { normalizeAppearance, setClientAppearance, defaultBackground } from "@/clientAppearance";
import { assertWorkspaceScope, captureWorkspaceScope, subscribeWorkspaceScope, workspaceHeaders } from '@/lib/workspaceRemote';

export const settings = ref<Record<string, unknown>>({});
let settingsReady = false;
let applyingSettings = false;
const STORAGE_KEY = "miaoimg.canvas.settings";

export const settingsStorage = {
  getItem(key: string) {
    const stores = settings.value.stores as Record<string, unknown> | undefined;
    if (stores && Object.hasOwn(stores, key)) return JSON.stringify(stores[key]);
    return localStorage.getItem(key);
  },
  setItem(key: string, value: string) {
    settings.value.stores = { ...(settings.value.stores as Record<string, unknown> | undefined), [key]: JSON.parse(value) };
  },
};

export const defaultUiSettings = { theme: "system" as "system" | "light" | "dark" | "custom", backgroundColor: defaultBackground, language: "zh-CN", primaryColor: "#f2f2f2", fontScale: 100, radius: 16, startupAnimation: true };

// 语言代码认全套（简繁、日、韩、阿拉伯语等），'system' 表示跟随浏览器；
// 中英双语时代存下来的 'zh' 由 i18n 的 normalizeLocale 当别名归一成 'zh-CN'。
function normalizeLocale(value: unknown) {
  if (value === "system") return "system";
  return normalizeCanvasLocale(value);
}

export const uiSettings = computed(() => {
  const raw = settings.value.ui;
  const ui = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    language: normalizeLocale(ui.language) ?? defaultUiSettings.language,
    ...normalizeAppearance(ui),
    fontScale: typeof ui.fontScale === "number" && Number.isFinite(ui.fontScale) ? Math.min(125, Math.max(85, ui.fontScale)) : defaultUiSettings.fontScale,
    radius: ui.visualVersion !== 2 && ui.radius === 8 ? defaultUiSettings.radius : typeof ui.radius === "number" && Number.isFinite(ui.radius) ? Math.min(16, Math.max(0, ui.radius)) : defaultUiSettings.radius,
    startupAnimation: ui.startupAnimation !== false,
  };
});

// 画布语言是用户自己挑过、还是从没动过（默认跟着顶栏的中/EN）：只有真的落过盘才算挑过。
export function hasStoredCanvasLanguage() {
  const ui = settings.value.ui;
  return !!ui && typeof ui === "object" && !Array.isArray(ui)
    && typeof (ui as Record<string, unknown>).language === "string";
}

export function updateUiSettings(patch: Partial<typeof defaultUiSettings>) {
  const current = settings.value.ui;
  settings.value = { ...settings.value, ui: { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...uiSettings.value, visualVersion: 2, paletteVersion: 3, ...patch } };
}

export const generalSettings = computed(() => {
  const raw = settings.value.general;
  const general = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const shortcuts = general.canvasShortcuts && typeof general.canvasShortcuts === "object" && !Array.isArray(general.canvasShortcuts)
    ? general.canvasShortcuts as Record<string, unknown> : {};
  const savedBindings = new Map(canvasShortcutFields.flatMap(field => {
    const value = shortcuts[field.id];
    const binding = typeof value === "string" ? normalizeShortcut(value) : undefined;
    return binding !== undefined && isShortcutAllowed(field, binding) ? [[field.id, binding] as const] : [];
  }));
  return {
    canvasCompositingEnabled: general.canvasCompositingEnabled === true,
    canvasEdgeAnimationEnabled: general.canvasEdgeAnimationEnabled === true,
    canvasEdgeColorMode: general.canvasEdgeColorMode === "none" || general.canvasEdgeColorMode === "custom" ? general.canvasEdgeColorMode : "theme",
    canvasEdgeColor: general.canvasEdgeColor === "#c99b5a" ? defaultUiSettings.primaryColor : typeof general.canvasEdgeColor === "string" && /^#[\da-f]{6}$/i.test(general.canvasEdgeColor) ? general.canvasEdgeColor : defaultUiSettings.primaryColor,
    canvasShortcuts: Object.fromEntries(canvasShortcutFields.map(field => {
      if (savedBindings.has(field.id)) return [field.id, savedBindings.get(field.id)];
      const binding = defaultCanvasShortcuts[field.id];
      const conflicts = canvasShortcutFields.some(other => other.gesture === field.gesture
        && getShortcutBindings(savedBindings.get(other.id) ?? "").some(value => getShortcutBindings(binding).includes(value)));
      return [field.id, conflicts ? "" : binding];
    })) as CanvasShortcuts,
  };
});

export function updateGeneralSettings(patch: Partial<typeof generalSettings.value>) {
  const current = settings.value.general;
  settings.value = { ...settings.value, general: { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...patch } };
}

export const privacySettings = computed(() => {
  const raw = settings.value.privacy;
  const privacy = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    dataCollectionEnabled: privacy.dataCollectionEnabled !== false,
    anonymousId: typeof privacy.anonymousId === "string" ? privacy.anonymousId : "",
  };
});

// MCP：只保存开关；访问令牌存在服务端（设置 → MCP 里生成/轮换）。
export const mcpSettings = computed(() => {
  const raw = settings.value.mcp;
  const mcp = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { enabled: mcp.enabled === true };
});

export function updateMcpSettings(patch: Partial<typeof mcpSettings.value>) {
  const current = settings.value.mcp;
  settings.value = { ...settings.value, mcp: { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...patch } };
}

export const personalizationSettings = computed(() => {
  const raw = settings.value.personalization;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { memoryEnabled: value.memoryEnabled !== false };
});

export function updatePersonalizationSettings(patch: Partial<typeof personalizationSettings.value>) {
  const current = settings.value.personalization;
  settings.value = { ...settings.value, personalization: { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...patch } };
}

// 节点目录：与 MiaoImg 的插件市场对应，妙图管理的是内置节点的启用状态。
export const nodeCatalog = [
  { type: "remote-textNode", label: "文本", group: "media" },
  { type: "remote-imageNode", label: "图片", group: "media" },
  { type: "remote-videoNode", label: "视频", group: "media" },
  { type: "remote-audioNode", label: "音频", group: "media" },
  { type: "remote-imageGenerationNode", label: "图片生成", group: "generate" },
  { type: "remote-videoGenerationNode", label: "视频生成", group: "generate" },
  { type: "remote-director3dNode", label: "3D 导演台", group: "generate" },
] as const;

export const nodeSettings = computed(() => {
  const raw = settings.value.nodes;
  const nodes = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const disabled = Array.isArray(nodes.disabledNodeTypes) ? nodes.disabledNodeTypes.filter((item): item is string => typeof item === "string") : [];
  return { disabledNodeTypes: disabled };
});

export function updateNodeSettings(patch: Partial<typeof nodeSettings.value>) {
  const current = settings.value.nodes;
  settings.value = { ...settings.value, nodes: { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...patch } };
}

// 自定义文本供应商：配置仍保存在服务端账号工作区，这里只保留旧数据兼容缓存。
export type CustomProviderModel = ProviderModelEntry;
export type CustomProvider = UserProvider;
export const customProviders = computed<CustomProvider[]>(() => userProviders().value);

// Agent 的默认文本模型只保存用户选择的服务端模型值；供应商、协议和能力细节不进入设置界面。
export const textModelSettings = computed(() => {
  const value = settings.value.textModel;
  return typeof value === "string" ? value : "";
});

export function updateTextModelSettings(value: string) {
  settings.value = { ...settings.value, textModel: value };
}

// 妙图的文本模型由服务端下发（/api/imagine/config）；账号供应商兼容数据不作为用户模型入口。
const serverTextModels = ref<{ providerId: string; providerLabel: string; modelId: string; label: string; note?: string; reasoning?: boolean; reasoningEffort?: string; reasoningEfforts?: string[]; contextWindow?: number }[]>([]);
const serverDefaultTextModel = ref("");
let serverModelsLoaded = false;
let serverModelsRequest: { controller: AbortController; promise: Promise<void> } | undefined;
const unsubscribeModels = subscribeWorkspaceScope(() => {
  serverModelsRequest?.controller.abort();
  serverModelsRequest = undefined;
  serverModelsLoaded = false;
  serverTextModels.value = [];
  serverDefaultTextModel.value = '';
});
export async function loadServerModelChoices(force = false) {
  if (serverModelsLoaded && !force) return;
  if (serverModelsRequest && !force) return serverModelsRequest.promise;
  serverModelsRequest?.controller.abort();
  const scope = captureWorkspaceScope();
  const pending = { controller: new AbortController(), promise: undefined as unknown as Promise<void> };
  serverModelsRequest = pending;
  pending.promise = (async () => {
    try {
      const response = await fetch("./api/imagine/config", { cache: "no-store", signal: pending.controller.signal, headers: workspaceHeaders(scope.owner) });
      try { assertWorkspaceScope(scope); pending.controller.signal.throwIfAborted(); }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('模型列表读取失败'); }
      const config = await response.json();
      assertWorkspaceScope(scope); pending.controller.signal.throwIfAborted();
      if (!Array.isArray(config?.textModels)) throw new Error('模型列表格式无效');
      const nextDefault = typeof config.defaultTextModel === "string" ? config.defaultTextModel : "";
      const nextModels = (config.textEnabled === false ? [] : config.textModels).filter((model: { configured?: boolean }) => model.configured !== false)
        .map((model: { id: string; label: string; provider?: string; providerLabel?: string; note?: string; reasoning?: boolean; reasoningEffort?: string; reasoningEfforts?: string[]; contextWindow?: number }) => ({
          providerId: "miaoimg", providerLabel: model.providerLabel || "妙图", modelId: model.id, label: model.label, note: model.note, reasoning: model.reasoning,
          // 思考档位来自服务端，保留完整选择能力。
          reasoningEffort: model.reasoningEffort,
          reasoningEfforts: model.reasoningEfforts,
          contextWindow: model.contextWindow,
        }));
      serverDefaultTextModel.value = nextDefault;
      serverTextModels.value = nextModels;
      serverModelsLoaded = true;
    } catch {
      if (serverModelsRequest === pending) serverModelsLoaded = false;
    } finally {
      if (serverModelsRequest === pending) serverModelsRequest = undefined;
    }
  })();
  return pending.promise;
}
import.meta.hot?.dispose(() => { unsubscribeModels(); serverModelsRequest?.controller.abort(); });

// 供应商增删改后刷新模型选择与节点模型目录。
export async function refreshProviderChoices() {
  await loadUserProviders(true).catch(() => []);
  invalidateNodeModels("language");
  await loadServerModelChoices(true);
}

export const modelChoices = computed(() => {
  const choices = serverTextModels.value.map(model => ({ value: JSON.stringify([model.providerId, model.modelId]), ...model }));
  const preferred = choices.find(model => model.modelId === serverDefaultTextModel.value);
  return preferred ? [preferred, ...choices.filter(model => model !== preferred)] : choices;
});

export async function loadSettings() {
  if (settingsReady) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings.value = parsed;
    }
  } catch { /* 存储损坏时回落到默认值 */ }
  settingsReady = true;
  setClientAppearance({ ...uiSettings.value, visualVersion: 2, paletteVersion: 3 });
  // 模型选项独立加载，不让第二次 config 请求挡住画布挂载。
  void loadServerModelChoices();
}

function persistSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.value));
}

export async function saveSettings(update?: (current: Record<string, unknown>) => Record<string, unknown> | undefined) {
  if (!settingsReady) await loadSettings();
  const patch = update?.(settings.value);
  if (update && !patch) return false;
  if (patch && Object.hasOwn(patch, "customProviders")) invalidateNodeModels("language");
  if (patch) {
    applyingSettings = true;
    try { settings.value = { ...settings.value, ...patch }; }
    finally { applyingSettings = false; }
  }
  try { persistSettings(); }
  catch { throw new Error("本机设置未能保存，请检查可用空间和存储权限后重试"); }
  return true;
}

// 外壳（React）只有中英两套词典，画布有 21 种：画布这边一换语言就通知外壳重新推导
// （中文系走中文外壳，其它语言一律英文外壳）。顶栏只有中/EN，但两套界面不该各说各话。
// 壳语言 → 画布的写回不会再触发一次通知，因为值没变。
watch(() => uiSettings.value.language, (value) => notifyCanvasLanguage(value), { flush: "sync" });
watch(uiSettings, value => { if (settingsReady) setClientAppearance({ ...value, visualVersion: 2, paletteVersion: 3 }); }, { flush: "sync" });

watch(settings, () => {
  if (!settingsReady || applyingSettings) return;
  try { persistSettings(); } catch { /* 隐私模式下忽略存储失败 */ }
}, { deep: true, flush: "sync" });

const syncStoredSettings = (event: StorageEvent) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    applyingSettings = true;
    settings.value = value;
  } catch { /* 保留当前设置，不使用损坏的跨窗口数据。 */ }
  finally { applyingSettings = false; }
};
window.addEventListener("storage", syncStoredSettings);
import.meta.hot?.dispose(() => window.removeEventListener("storage", syncStoredSettings));
