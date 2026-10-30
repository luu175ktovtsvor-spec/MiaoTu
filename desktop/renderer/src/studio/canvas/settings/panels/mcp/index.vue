<template>
  <div class="mcpPanel">
    <settings-section>
      <settings-row :label="translate('开启 MCP')" :description="translate('允许 Claude Code、Codex 等外部编程工具操作画布。开启后把下面的配置填进对应工具。')">
        <el-switch :modelValue="mcpSettings.enabled" :loading="saving" :disabled="busy" :aria-label="translate('开启 MCP')" @change="(value) => setEnabled(value === true)" />
      </settings-row>
      <p class="mcpNote">{{ translate('开启本机操作后，外部 Agent 还能把电脑上的素材导入画布、把项目文件导出到电脑；原件保留，不覆盖已有文件。') }}</p>
    </settings-section>

    <settings-section :title="translate('访问令牌')" :description="translate('令牌保存在这台电脑上，正常重启后继续有效。重新生成会使旧配置失效；只发给可信的客户端。')">
      <template #actions>
        <el-button text size="small" :icon="IconRefresh" :loading="busy" :disabled="saving" @click="rotateToken">{{ hasToken ? translate('重新生成') : translate('生成令牌') }}</el-button>
        <el-button text size="small" :icon="IconCopy" :disabled="!token || busy || saving || !!statusError" @click="copyText(token, translate('MCP 访问令牌'), true)">{{ translate('复制') }}</el-button>
      </template>
      <el-input
        :modelValue="token || (hasToken ? translate('已生成，出于安全不再展示；可重新生成') : translate('尚未生成'))"
        :type="token ? 'password' : 'text'"
        dir="ltr"
        readonly
        :aria-label="translate('MCP 访问令牌')" />
      <div class="fieldActions">
        <el-button :icon="IconCopy" :disabled="!mcpSettings.enabled || busy || saving || statusBusy || !!statusError" @click="copyConfig">{{ translate('复制配置') }}</el-button>
        <el-button :icon="IconCopy" :disabled="!mcpSettings.enabled || busy || saving || statusBusy || !!statusError" @click="copyCodexConfig">{{ translate('复制 Codex 配置') }}</el-button>
      </div>
    </settings-section>

    <settings-section :title="translate('连接状态')" :description="translate('操作画布需要妙图页面保持打开。')">
      <template #actions>
        <el-button text size="small" :icon="IconRefresh" :loading="statusBusy" :disabled="busy || saving" @click="refreshStatus">{{ translate('刷新') }}</el-button>
      </template>
      <feedbackNotice v-if="statusError" :message="statusError"  />
      <template v-else>
        <div class="connectionState">
          <el-tag :type="status?.enabled ? 'success' : 'info'" effect="plain">{{ status?.enabled ? translate('已开启') : translate('已关闭') }}</el-tag>
          <span v-if="status?.enabled">{{ t`${status?.connections?.length || 0} 个画布页面已连接` }}</span>
        </div>
        <ul v-if="status?.connections?.length" class="connectionList">
          <li v-for="connection in status.connections" :key="connection.id">
            <span>{{ connection.directory || translate('画布') }}</span>
            <small>{{ connection.panel === 'document' ? translate('文档') : translate('画布') }}</small>
          </li>
        </ul>
      </template>
    </settings-section>

    <settings-section :title="translate('服务地址')" :description="translate('供同一台电脑上的外部 Agent 连接。正常重启保留地址；切换项目或端口被占用后重新复制配置。')">
      <el-input :modelValue="endpoint" dir="ltr" readonly :aria-label="translate('MCP 服务地址')" />
    </settings-section>

    <settings-section :title="translate('妙图 Skill')" :description="translate('教外部工具组合使用画布工具，把 SKILL.md 放进对应工具的技能目录。')">
      <template #actions>
        <el-button text size="small" :icon="IconFileText" :loading="skillAction === 'view'" :disabled="!!skillAction" @click="handleSkill('view')">{{ translate('查看') }}</el-button>
        <el-button text size="small" :icon="IconCopy" :loading="skillAction === 'copy'" :disabled="!!skillAction" @click="handleSkill('copy')">{{ translate('复制') }}</el-button>
        <el-button text size="small" :icon="IconDownload" :loading="skillAction === 'download'" :disabled="!!skillAction" @click="handleSkill('download')">{{ translate('导出') }}</el-button>
      </template>
    </settings-section>

    <el-dialog v-model="skillVisible" :title="translate('妙图 Skill')" width="min(760px, calc(100vw - 32px))" alignCenter appendToBody>
      <div class="skillContent"><messageMarkdown :content="skillContent" /></div>
    </el-dialog>
    <el-dialog v-model="copyVisible" :title="translate('复制 {0}', { 0: copyTitle })" width="min(680px, calc(100vw - 32px))" alignCenter appendToBody>
      <p class="copyHint">{{ translate('请选中下面的文本手动复制。') }}{{ copyHasCredential ? translate('此配置包含访问凭证，只发给可信的客户端。') : '' }}</p>
      <el-input :modelValue="copyContent" type="textarea" dir="ltr" :autosize="{ minRows: 8, maxRows: 18 }" readonly :aria-label="copyTitle" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import feedbackNotice from '../../../components/feedbackNotice.vue';
import { t, translate } from "@miaoimg/i18n/vue";
import { computed, inject, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { IconCopy, IconDownload, IconFileText, IconRefresh } from "@tabler/icons-vue";
import settingsRow from "../../components/settingsRow.vue";
import settingsSection from "../../components/settingsSection.vue";
import { mcpSettings, updateMcpSettings } from "@/stores/settings";
import { mcpConnectionRevision } from "@/lib/mcpControl";
import { parseMcpAccess, type McpAccess } from "@/lib/mcpAccess";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";
import messageMarkdown from "@/studio/canvas/components/messageMarkdown.vue";

type McpStatus = { enabled: boolean; connections: { id: string; directory?: string | null; panel?: string }[] };

const binding = captureWorkspaceScope();
const lifetime = new AbortController();
onScopeDispose(() => lifetime.abort());
let statusRequest = 0;
const token = ref("");
const hasToken = ref(false);
const busy = ref(false);
const saving = ref(false);
const statusBusy = ref(false);
const statusError = ref("");
const status = ref<McpStatus | null>(null);
const skillContent = ref("");
const skillVisible = ref(false);
const skillAction = ref<"view" | "copy" | "download" | "">("");
const copyVisible = ref(false);
const copyContent = ref("");
const copyTitle = ref("");
const copyHasCredential = ref(false);
const workspaceProjectControl = inject<{ current?: string } | undefined>("workspaceProjectControl", undefined);

const endpoint = computed(() => {
  const project = workspaceProjectControl?.current;
  return window.location.origin + "/mcp" + (project ? `?project=${encodeURIComponent(project)}` : "");
});

function assertCurrent() {
  lifetime.signal.throwIfAborted();
  assertWorkspaceScope(binding);
}
function isCurrent() {
  try { assertCurrent(); return true; } catch { return false; }
}

async function api(path: string, init?: RequestInit) {
  assertCurrent();
  const response = await fetch(path, { credentials: "same-origin", ...init, signal: init?.signal ? AbortSignal.any([lifetime.signal, init.signal]) : lifetime.signal, headers: { "x-miaoimg-workspace": "1", ...(init?.headers || {}) } });
  const text = await response.text();
  assertCurrent();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(response.ok ? translate("未收到有效的 MCP 响应，请刷新后重试") : translate("请求失败（{0}）", { 0: response.status })); }
  if (!response.ok) throw new Error(typeof data?.error === "string" && data.error ? data.error : translate("请求失败（{0}）", { 0: response.status }));
  if (!data || typeof data !== "object" || Array.isArray(data) || data.ok !== true) throw new Error(translate("未收到有效的 MCP 响应，请刷新后重试"));
  return data;
}

function readAccess(data: Record<string, unknown>): McpAccess {
  const access = parseMcpAccess(data);
  if (!access || access.desktop !== true) throw new Error(translate("未收到有效的 MCP 响应，请刷新后重试"));
  return access;
}

function applyAccess(access: McpAccess) {
  hasToken.value = access.hasToken;
  if (access.desktop || access.token !== undefined || !access.hasToken) token.value = access.token || "";
  updateMcpSettings({ enabled: access.enabled });
}

async function refreshStatus() {
  if (busy.value || saving.value || !isCurrent()) return;
  const request = ++statusRequest;
  statusBusy.value = true;
  statusError.value = "";
  try {
    const [nextStatus, data] = await Promise.all([api("/api/mcp/status", { cache: "no-store" }), api("/api/imagine/mcp", { cache: "no-store" })]);
    if (request !== statusRequest || !isCurrent()) return;
    const access = readAccess(data);
    if (typeof nextStatus.enabled !== "boolean" || !Array.isArray(nextStatus.connections)
      || nextStatus.connections.some(item => !item || typeof item.id !== "string")
      || nextStatus.enabled !== access.enabled) throw new Error(translate("MCP 状态已变化，请刷新后重试"));
    status.value = nextStatus;
    applyAccess(access);
  } catch (error) {
    if (request === statusRequest && isCurrent()) statusError.value = error instanceof Error ? error.message : translate("读取 MCP 状态失败");
  } finally {
    if (request === statusRequest) statusBusy.value = false;
  }
}
watch(mcpConnectionRevision, () => { if (!lifetime.signal.aborted) void refreshStatus(); });

async function setEnabled(enabled: boolean) {
  if (busy.value || saving.value || !isCurrent()) return;
  saving.value = true;
  ++statusRequest;
  statusBusy.value = false;
  statusError.value = "";
  let saved = false;
  // 服务端授权与当前页面控制通道共用这个开关。
  try {
    let access = readAccess(await api("/api/imagine/mcp", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }));
    // Hosted accounts need a first token before the enabled flag becomes true.
    // Only a valid acknowledgement may lead to that explicit first creation.
    if (enabled && !access.hasToken) access = await generateToken();
    if (access.enabled !== enabled) throw new Error(translate("MCP 状态已变化，请刷新后重试"));
    applyAccess(access);
    window.dispatchEvent(new CustomEvent('miao-mcp-settings-changed', { detail: { enabled } }));
    saved = true;
  } catch (error) {
    if (isCurrent()) statusError.value = error instanceof Error ? error.message : translate("更新 MCP 状态失败");
  } finally {
    saving.value = false;
  }
  if (saved) await refreshStatus();
}

async function generateToken() {
  // Once rotation was requested, the old token may already be invalid even if
  // the acknowledgement is lost. Do not copy it as a current credential.
  token.value = "";
  const access = readAccess(await api("/api/imagine/mcp", { method: "POST" }));
  if (!access.hasToken || ((!access.desktop || access.enabled) && !access.token)) throw new Error(translate("未收到有效的 MCP 响应，请刷新后重试"));
  return access;
}

async function rotateToken() {
  if (busy.value || saving.value || !isCurrent()) return false;
  busy.value = true;
  ++statusRequest;
  statusBusy.value = false;
  statusError.value = "";
  let saved = false;
  try {
    applyAccess(await generateToken());
    saved = true;
  } catch (error) {
    if (isCurrent()) statusError.value = error instanceof Error ? error.message : translate("生成令牌失败");
  } finally {
    busy.value = false;
  }
  if (saved) await refreshStatus();
  return saved && !statusError.value && isCurrent();
}

async function copyText(content: string, title: string, hasCredential = false) {
  if (!content || !isCurrent()) return;
  try {
    if (window.miaoDesktop) await window.miaoDesktop.writeClipboardText(content);
    else await navigator.clipboard.writeText(content);
    assertCurrent();
    ElMessage.success(translate("{0}已复制", { 0: title }));
    return;
  } catch {
    if (!isCurrent()) return;
    copyContent.value = content;
    copyTitle.value = title;
    copyHasCredential.value = hasCredential;
    copyVisible.value = true;
  }
}

async function copyConfig() {
  if (!mcpSettings.value.enabled || busy.value || saving.value || statusBusy.value || statusError.value || !isCurrent()) return;
  if (!token.value && !await rotateToken()) return;
  if (!token.value || !mcpSettings.value.enabled || !isCurrent()) return;
  await copyText(JSON.stringify({ mcpServers: { miaoimg: { type: "http", url: endpoint.value, headers: { Authorization: "Bearer " + token.value } } } }, null, 2), "MCP 配置", true);
}

async function copyCodexConfig() {
  if (!mcpSettings.value.enabled || busy.value || saving.value || statusBusy.value || statusError.value || !isCurrent()) return;
  if (!token.value && !await rotateToken()) return;
  if (!token.value || !mcpSettings.value.enabled || !isCurrent()) return;
  await copyText(`[mcp_servers.miaoimg]\nurl = ${JSON.stringify(endpoint.value)}\nhttp_headers = { Authorization = ${JSON.stringify("Bearer " + token.value)} }\n`, "Codex MCP 配置", true);
}

async function readSkill() {
  if (skillContent.value) return skillContent.value;
  const data = await api("/api/imagine/mcp-skill", { cache: "no-store" });
  skillContent.value = String(data.content || "");
  return skillContent.value;
}

async function handleSkill(action: "view" | "copy" | "download") {
  skillAction.value = action;
  try {
    const content = await readSkill();
    if (action === "view") skillVisible.value = true;
    else if (action === "copy") await copyText(content, "Skill");
    else {
      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "SKILL.md";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("读取 Skill 失败"));
  } finally {
    skillAction.value = "";
  }
}

onMounted(() => { void refreshStatus(); });
</script>

<style scoped lang="scss">
.mcpNote { margin: 12px 0 0; padding-top: 12px; border-top: .5px solid var(--el-border-color); color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.mcpPanel {
  display: flex;
  flex-direction: column;
  gap: 20px;

  :deep(.el-alert) { margin-bottom: 10px; }

  .fieldActions {
    display: flex;
    gap: 8px;
    margin-top: 10px;

    :deep(.el-button + .el-button) { margin-left: 0; }
  }

  .connectionState {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 13px;
    color: var(--el-text-color-regular);
  }

  .connectionList {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0;
    margin: 10px 0 0;
    list-style: none;

    li {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
      color: var(--el-text-color-regular);
      overflow-wrap: anywhere;

      small { flex-shrink: 0; color: var(--el-text-color-secondary); }
    }
  }
}

.skillContent { max-height: 65vh; overflow: auto; }
.copyHint { margin: 0 0 12px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
</style>
