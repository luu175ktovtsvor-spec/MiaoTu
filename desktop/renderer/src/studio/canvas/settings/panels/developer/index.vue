<template>
  <div class="developerPanel">
    <settings-section>
      <settings-row :label="translate('Agent 系统提示词')" :description="translate('Agent 的基础指令，留空则用妙图默认；保存后下一条消息生效。')" control-width="160px">
        <el-button :icon="IconEdit" @click="openPrompt">{{ translate('编辑') }}</el-button>
      </settings-row>

      <settings-row :label="translate('供应商开发工具')" :description="translate('查看妙图的模型目录和自定义供应商配置，不含 Key。')" control-width="160px">
        <el-button :icon="IconCode" @click="openProviders">{{ translate('供应商调试') }}</el-button>
      </settings-row>

      <settings-row :label="translate('强制安装')" :description="translate('安装节点插件或技能时跳过版本检查，可覆盖同版本或更旧的版本；刷新页面后自动关闭。')">
        <el-switch v-model="forceInstall" :aria-label="translate('强制安装')" />
      </settings-row>

      <settings-row :label="translate('运行时诊断')" :description="translate('导出画布上下文、工作区文件统计和浏览器信息。')" control-width="160px">
        <el-button type="primary" :icon="IconDownload" :loading="diagnosing" @click="exportDiagnostics">{{ translate('导出诊断信息') }}</el-button>
      </settings-row>

      <settings-row :label="translate('浏览器开发者工具')" :description="translate('在浏览器里按 F12（macOS 用 ⌥⌘I）打开。')" />
    </settings-section>

    <settings-section :title="translate('浏览器持久缓存')" :description="translate('管理当前站点的 localStorage（画布设置等）；导入会覆盖同名项，重新加载页面后生效。')">
      <template #actions>
        <input ref="storageFileInput" type="file" accept=".json,application/json" hidden @change="importStorage" />
        <el-button text size="small" :icon="IconUpload" :loading="importingStorage" :disabled="storageBusy" @click="storageFileInput?.click()">{{ translate('导入') }}</el-button>
        <el-button text size="small" :icon="IconDownload" :disabled="storageBusy" @click="exportStorage">{{ translate('导出') }}</el-button>
        <el-button text size="small" :icon="IconRefresh" :disabled="storageBusy" @click="loadStorage">{{ translate('刷新列表') }}</el-button>
      </template>

      <feedbackNotice v-if="storageError" :message="storageError"  />
      <feedbackNotice v-else-if="storageMessage" :message="storageMessage" :error="false" />

      <div v-for="entry in storageEntries" :key="entry.key" class="storageItem">
        <div class="storageHeader">
          <span class="storageKey">{{ entry.key || translate('（空键名）') }}</span>
          <div class="storageActions">
            <el-button :icon="IconEdit" text size="small" :disabled="storageBusy" :aria-label="translate('修改 {0}', { 0: entry.key })" @click="editStorage(entry)">{{ translate('修改') }}</el-button>
            <el-popconfirm :title="translate('确定删除这条缓存？')" :confirmButtonText="translate('删除')" :cancelButtonText="translate('取消')" @confirm="writeStorage(entry, null)">
              <template #reference>
                <el-button :icon="IconTrash" type="danger" text size="small" :disabled="storageBusy" :aria-label="translate('删除 {0}', { 0: entry.key })">{{ translate('删除') }}</el-button>
              </template>
            </el-popconfirm>
          </div>
        </div>
        <template v-if="editingKey === entry.key">
          <el-input v-model="storageValue" type="textarea" :rows="5" :disabled="storageBusy" :aria-label="translate('{0} 的值', { 0: entry.key })" />
          <div class="storageActions">
            <el-button size="small" :disabled="storageBusy" @click="editingKey = null">{{ translate('取消') }}</el-button>
            <el-button type="primary" size="small" :loading="writingStorage" :disabled="storageBusy" @click="writeStorage(entry, storageValue)">{{ translate('保存') }}</el-button>
          </div>
        </template>
        <div v-else class="storageValue">{{ entry.value }}</div>
      </div>
    </settings-section>

    <feedbackNotice v-if="message" :message="message" :error="error" />

    <el-dialog v-model="promptVisible" :title="translate('Agent 系统提示词')" width="min(760px, calc(100vw - 32px))" alignCenter appendToBody>
      <el-input v-model="promptContent" type="textarea" :autosize="{ minRows: 10, maxRows: 20 }" :aria-label="translate('Agent 系统提示词')" />
      <template #footer>
        <el-button @click="promptVisible = false">{{ translate('取消') }}</el-button>
        <el-button type="primary" :loading="saving" @click="savePrompt">{{ translate('保存') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="providersVisible" :title="translate('供应商调试')" width="min(760px, calc(100vw - 32px))" alignCenter appendToBody>
      <div class="providerDebug">
        <feedbackNotice v-if="providersError" :message="providersError"  />
        <template v-else>
          <div class="debugToolbar">
            <el-text size="small" type="info">{{ t`自定义供应商 ${customProviders.length} 个 · 视频模型 ${videoCount} 个 · 图片模型 ${imageCount} 个 · 文本模型 ${textCount} 个` }}</el-text>
            <el-button size="small" :icon="IconRefresh" :loading="providersLoading" @click="loadProviders">{{ translate('刷新') }}</el-button>
            <el-button size="small" :icon="IconCopy" @click="copyProviders">{{ translate('复制 JSON') }}</el-button>
          </div>
          <pre class="debugJson">{{ providersJson }}</pre>
        </template>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import feedbackNotice from '../../../components/feedbackNotice.vue';
import { t, translate } from "@miaoimg/i18n/vue";
import { forceInstall } from "../../installOptions";
import { computed, onMounted, ref } from "vue";
import { ElButton, ElDialog, ElInput, ElPopconfirm, ElText } from "element-plus";
import { IconCode, IconCopy, IconDownload, IconEdit, IconRefresh, IconTrash, IconUpload } from "@tabler/icons-vue";
import settingsRow from "../../components/settingsRow.vue";
import settingsSection from "../../components/settingsSection.vue";

const promptVisible = ref(false);
const promptContent = ref("");
const revision = ref<string | null>(null);
const saving = ref(false);
const diagnosing = ref(false);
const message = ref("");
const error = ref(false);

const providersVisible = ref(false);
const providersLoading = ref(false);
const providersError = ref("");
const providersJson = ref("");
const customProviders = ref<{ id?: string }[]>([]);
const videoCount = ref(0);
const imageCount = ref(0);
const textCount = ref(0);

const storageEntries = ref<{ key: string; value: string }[]>([]);
const storageError = ref("");
const storageMessage = ref("");
const storageValue = ref("");
const storageFileInput = ref<HTMLInputElement>();
const importingStorage = ref(false);
const writingStorage = ref(false);
const editingKey = ref<string | null>(null);
const storageBusy = computed(() => importingStorage.value || writingStorage.value);

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { "x-miaoimg-workspace": "1", "content-type": "application/json", ...(init?.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) throw new Error(data?.error || translate("请求失败（{0}）", { 0: response.status }));
  return data as { content?: string; revision?: string | null };
}

async function openPrompt() {
  message.value = "";
  error.value = false;
  try {
    const data = await api("/api/imagine/personalization?document=system", { method: "GET" });
    promptContent.value = data.content || "";
    revision.value = data.revision ?? null;
    promptVisible.value = true;
  } catch (loadError) {
    error.value = true;
    message.value = loadError instanceof Error ? loadError.message : translate("读取提示词失败");
  }
}

async function savePrompt() {
  saving.value = true;
  message.value = "";
  error.value = false;
  try {
    const data = await api("/api/imagine/personalization", { method: "POST", body: JSON.stringify({ document: "system", content: promptContent.value, revision: revision.value }) });
    revision.value = data.revision ?? revision.value;
    promptVisible.value = false;
    message.value = promptContent.value.trim() ? translate("已保存，下一条 Agent 消息生效") : translate("已清空，恢复默认提示词");
  } catch (saveError) {
    error.value = true;
    message.value = saveError instanceof Error ? saveError.message : translate("保存失败，请重试");
  } finally {
    saving.value = false;
  }
}

async function loadProviders() {
  providersLoading.value = true;
  providersError.value = "";
  try {
    const [config, providers] = await Promise.all([
      fetch("/api/imagine/config", { cache: "no-store", credentials: "same-origin" }).then(response => response.json()),
      fetch("/api/imagine/providers", { cache: "no-store", credentials: "same-origin", headers: { "x-miaoimg-workspace": "1" } }).then(response => response.json()),
    ]);
    const list = Array.isArray(providers.providers) ? providers.providers : [];
    customProviders.value = list;
    videoCount.value = (config.videoModels || []).length;
    imageCount.value = (config.models || []).length;
    textCount.value = (config.textModels || []).length;
    providersJson.value = JSON.stringify({
      官方模型: { 图片: config.models || [], 视频: config.videoModels || [], 文本: config.textModels || [] },
      自定义供应商: list,
    }, null, 2);
  } catch (loadError) {
    providersError.value = loadError instanceof Error ? loadError.message : translate("读取供应商信息失败");
  } finally {
    providersLoading.value = false;
  }
}

function openProviders() {
  providersVisible.value = true;
  void loadProviders();
}

async function copyProviders() {
  try {
    await navigator.clipboard.writeText(providersJson.value);
    message.value = translate("供应商配置已复制（不含任何 Key）");
    error.value = false;
  } catch {
    window.prompt(translate("供应商配置"), providersJson.value);
  }
}

async function exportDiagnostics() {
  diagnosing.value = true;
  message.value = "";
  error.value = false;
  try {
    const [files, config, agentStatus] = await Promise.all([
      fetch("/api/imagine/workspace/files", { cache: "no-store", credentials: "same-origin" }).then(response => response.json()).catch(() => ({})),
      fetch("/api/imagine/config", { cache: "no-store", credentials: "same-origin" }).then(response => response.json()).catch(() => ({})),
      fetch("/api/mcp/status", { cache: "no-store", credentials: "same-origin", headers: { "x-miaoimg-workspace": "1" } }).then(response => response.json()).catch(() => ({})),
    ]);
    const entries = (files.entries || []).map((entry: { path: string; mime?: string; size?: number }) => ({ path: entry.path, mime: entry.mime, size: entry.size }));
    const report = {
      exportedAt: new Date().toISOString(),
      page: window.location.href,
      browser: { userAgent: navigator.userAgent, language: navigator.language, platform: navigator.platform },
      workspace: { fileCount: entries.length, canvasFiles: entries.filter((entry: { path: string }) => entry.path.endsWith(".json")).map((entry: { path: string }) => entry.path), agentHistory: entries.filter((entry: { path: string }) => entry.path.startsWith("agent/")).length, mediaFiles: entries.filter((entry: { path: string }) => entry.path.startsWith("assets/")).length },
      models: { image: (config.models || []).map((model: { id: string; configured?: boolean }) => model.id + ":" + (model.configured === false ? "未配置" : "可用")), video: (config.videoModels || []).map((model: { id: string; durations?: number[] }) => model.id + ":" + (model.durations || []).join("/") + "秒"), text: (config.textModels || []).map((model: { id: string; configured?: boolean }) => model.id + ":" + (model.configured === false ? "未配置" : "可用")) },
      mcp: { tokenConfigured: agentStatus?.enabled === true, connections: (agentStatus?.connections || []).length },
      settings: { canvas: JSON.parse(localStorage.getItem("miaoimg.canvas.settings") || "{}") },
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "miaoimg-diagnostics-" + Date.now() + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.value = translate("诊断信息已导出（含工作区统计与模型清单，不含密钥）");
  } catch (diagnoseError) {
    error.value = true;
    message.value = diagnoseError instanceof Error ? diagnoseError.message : translate("导出失败，请重试");
  } finally {
    diagnosing.value = false;
  }
}

function readStorage() {
  return Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key) ?? ""]));
}

function saveStorage(entries: [string, string | null][]) {
  const previous = entries.map(([key]) => [key, localStorage.getItem(key)] as const);
  try {
    for (const [key, value] of entries) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  } catch (storageWriteError) {
    for (const [key, value] of previous) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    throw storageWriteError;
  }
}

function loadStorage() {
  storageError.value = "";
  storageMessage.value = "";
  try {
    storageEntries.value = Object.entries(readStorage()).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({ key, value }));
  } catch (readError) {
    storageError.value = readError instanceof Error ? readError.message : translate("读取缓存失败");
  }
}

async function importStorage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || storageBusy.value) return;
  importingStorage.value = true;
  storageError.value = "";
  storageMessage.value = "";
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(translate("缓存文件格式不正确"));
    const entries = Object.entries(parsed).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)] as [string, string]);
    saveStorage(entries);
    loadStorage();
    storageMessage.value = translate("已导入 {0} 项，重新加载页面后生效。", { 0: entries.length });
  } catch (importError) {
    storageError.value = importError instanceof Error ? importError.message : translate("导入缓存失败");
  } finally {
    importingStorage.value = false;
  }
}

function exportStorage() {
  storageError.value = "";
  storageMessage.value = "";
  try {
    const blob = new Blob([JSON.stringify(readStorage(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "miaoimgLocalStorage.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (exportError) {
    storageError.value = exportError instanceof Error ? exportError.message : translate("导出缓存失败");
  }
}

function editStorage(entry: { key: string; value: string }) {
  editingKey.value = entry.key;
  storageValue.value = entry.value;
}

function writeStorage(entry: { key: string; value: string }, value: string | null) {
  if (storageBusy.value) return;
  writingStorage.value = true;
  storageError.value = "";
  storageMessage.value = "";
  try {
    if (readStorage()[entry.key] !== entry.value) throw new Error(translate("这条数据已发生变化，请刷新列表后重试。"));
    saveStorage([[entry.key, value]]);
    editingKey.value = null;
    loadStorage();
    storageMessage.value = translate("已保存，重新加载页面后生效。");
  } catch (writeError) {
    storageError.value = writeError instanceof Error ? writeError.message : translate("更新缓存失败");
  } finally {
    writingStorage.value = false;
  }
}

onMounted(loadStorage);
</script>

<style scoped lang="scss">
.developerPanel {
  display: flex;
  flex-direction: column;
  gap: 20px;

  :deep(.el-alert) { margin-bottom: 10px; }

  .storageItem {
    padding: 10px 12px;
    margin-top: 10px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: var(--el-border-radius-base);

    .storageHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;

      .storageKey {
        font-size: 12px;
        font-weight: 600;
        color: var(--el-text-color-primary);
        overflow-wrap: anywhere;
      }

      .storageActions { display: flex; flex-shrink: 0; gap: 4px; }
    }

    .storageActions {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      margin-top: 8px;

      :deep(.el-button + .el-button) { margin-left: 0; }
    }

    .storageValue {
      margin-top: 6px;
      color: var(--el-text-color-secondary);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      line-height: 1.6;
      max-height: 80px;
      overflow: auto;
      overflow-wrap: anywhere;
    }
  }

  .providerDebug {
    .debugToolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .debugJson {
      margin: 0;
      max-height: 55vh;
      overflow: auto;
      padding: 12px;
      border-radius: var(--el-border-radius-base);
      background: var(--el-fill-color-light);
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  }
}
</style>
