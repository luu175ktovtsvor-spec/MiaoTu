<template>
  <div class="personalization">
    <settings-section :title="translate('创作说明')" :description="translate('保存后从下一条消息开始用')">
      <feedbackNotice v-if="document.error" :message="document.error"  />
      <el-input
        v-model="document.content"
        type="textarea"
        :autosize="{ minRows: 5, maxRows: 10 }"
        :disabled="!document.loaded || document.loading"
        resize="none"
        :aria-label="translate('创作说明内容')" />
      <div class="editorFooter">
        <span class="editorStatus">
          {{ document.loading ? translate("正在读取…") : isDirty(document) ? translate("有未保存的修改") : "" }}
          <span>{{ document.content.length }} {{ translate("字符") }}</span>
        </span>
        <div class="editorActions">
          <el-button
            :icon="IconRefresh"
            :loading="document.loading"
            :disabled="document.saving"
            :aria-label="translate('重新加载创作说明')"
            @click="reloadDocument(document, 'agents')">
            {{ document.loaded ? translate("重新加载") : translate("重试") }}
          </el-button>
          <el-button
            type="primary"
            :icon="IconDeviceFloppy"
            :loading="document.saving"
            :disabled="!document.loaded || document.loading || !isDirty(document)"
            :aria-label="translate('保存创作说明')"
            @click="saveDocument(document, 'agents')">
            {{ translate('保存') }}
          </el-button>
        </div>
      </div>
    </settings-section>

    <settings-section :title="translate('创作记忆')" :description="translate('关闭后不再使用，已有内容保留')">
      <settings-row :label="translate('启用创作记忆')">
        <el-switch
          :modelValue="memoryEnabled"
          :loading="savingMemorySetting"
          :aria-label="translate('启用创作记忆')"
          @change="(value) => setMemoryEnabled(value === true)" />
      </settings-row>
      <settings-row :label="translate('查看创作记忆')">
        <el-button
          :icon="IconEye"
          :loading="memoryAction === 'view'"
          :disabled="!!memoryAction || memoryDocument.loading || memoryDocument.saving"
          :aria-label="translate('查看创作记忆')"
          @click="viewMemory">
          {{ translate('查看') }}
        </el-button>
      </settings-row>
      <settings-row :label="translate('删除创作记忆')">
        <el-button
          :icon="IconTrash"
          :loading="memoryAction === 'delete'"
          :disabled="!!memoryAction || memoryDocument.loading || memoryDocument.saving"
          :aria-label="translate('删除创作记忆')"
          @click="deleteMemory">
          {{ translate('删除') }}
        </el-button>
      </settings-row>
    </settings-section>

    <el-dialog class="settingsSubdialog" :style="dialogTheme" v-model="memoryVisible" :title="translate('创作记忆')" width="min(760px, calc(100vw - 32px))" alignCenter appendToBody>
      <div class="memoryContent">
        <feedbackNotice v-if="memoryDocument.error" :message="memoryDocument.error"  />
        <el-input
          v-if="memoryEditing"
          v-model="memoryDocument.content"
          type="textarea"
          :autosize="{ minRows: 10, maxRows: 18 }"
          :disabled="memoryDocument.loading || memoryAction === 'delete'"
          resize="none"
          :aria-label="translate('创作记忆内容')" />
        <messageMarkdown v-else-if="memoryDocument.content.trim()" :content="memoryDocument.content" />
        <el-empty v-else :description="translate('暂无创作记忆')" :imageSize="80" />
      </div>
      <template #footer>
        <div class="memoryFooter">
          <span class="editorStatus">
            {{ isDirty(memoryDocument) ? translate("有未保存的修改") + " · " : "" }}{{ memoryDocument.content.length }} {{ translate("字符") }}
          </span>
          <div class="editorActions">
            <el-button
              :icon="IconRefresh"
              :loading="memoryDocument.loading"
              :disabled="memoryDocument.saving"
              :aria-label="translate('重新加载创作记忆')"
              @click="reloadDocument(memoryDocument, 'memory')">
              {{ translate('重新加载') }}
            </el-button>
            <el-button
              v-if="memoryEditing"
              type="primary"
              :icon="IconDeviceFloppy"
              :loading="memoryDocument.saving"
              :disabled="memoryDocument.loading || !isDirty(memoryDocument)"
              :aria-label="translate('保存创作记忆')"
              @click="saveDocument(memoryDocument, 'memory')">
              {{ translate('保存') }}
            </el-button>
            <el-button v-else type="primary" :icon="IconEdit" :disabled="memoryDocument.loading" :aria-label="translate('编辑创作记忆')" @click="memoryEditing = true">
              {{ translate('编辑') }}
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import feedbackNotice from '../../components/feedbackNotice.vue';
import { translate } from "@miaoimg/i18n/vue";
import { computed, reactive, ref, onBeforeUnmount } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { IconDeviceFloppy, IconEdit, IconEye, IconRefresh, IconTrash } from "@tabler/icons-vue";
import settingsRow from "../components/settingsRow.vue";
import settingsSection from "../components/settingsSection.vue";
import { dialogTheme } from "../dialogTheme";
import { settings, updatePersonalizationSettings } from "@/stores/settings";
import messageMarkdown from "@/studio/canvas/components/messageMarkdown.vue";
import { captureWorkspaceScope, assertWorkspaceScope, workspaceHeaders } from "@/lib/workspaceRemote";

type DocumentState = {
  content: string;
  savedContent: string;
  revision: string | null;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
};

const scope = captureWorkspaceScope(), controller = new AbortController();
function assertActive() { assertWorkspaceScope(scope); controller.signal.throwIfAborted(); }
onBeforeUnmount(() => controller.abort());
const document = reactive<DocumentState>({ content: "", savedContent: "", revision: null, loaded: false, loading: false, saving: false, error: "" });
const memoryDocument = reactive<DocumentState>({ content: "", savedContent: "", revision: null, loaded: false, loading: false, saving: false, error: "" });
const savingMemorySetting = ref(false);
const memoryAction = ref<"view" | "delete" | "">("");
const memoryVisible = ref(false);
const memoryEditing = ref(false);

const memoryEnabled = computed(() => {
  const value = settings.value.personalization;
  return !value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).memoryEnabled !== false;
});

function isDirty(target: DocumentState) {
  return target.content !== target.savedContent;
}

async function api(path: string, init?: RequestInit) {
  assertActive();
  const response = await fetch(path, { credentials: "same-origin", ...init, cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), headers: { ...workspaceHeaders(scope.owner), "x-miaoimg-workspace": "1", ...(init?.headers || {}) } });
  try { assertActive(); }
  catch (cause) { await response.body?.cancel().catch(() => {}); throw cause; }
  const data = await response.json().catch(() => undefined);
  assertActive();
  if (!response.ok) throw Object.assign(new Error(translate("请求失败（{0}）", { 0: response.status })), { status: response.status });
  if (data?.ok !== true || typeof data.content !== "string"
    || !(data.revision === null || (typeof data.revision === "string" && data.revision.length > 0))) {
    throw new Error(translate("操作结果尚未确认，请保留当前内容并核对后再继续"));
  }
  return data as { content: string; revision: string | null };
}

async function loadDocument(target: DocumentState, name: "agents" | "memory", discardChanges = false) {
  if (target.loading || target.saving || (!discardChanges && isDirty(target))) return false;
  target.loading = true;
  target.error = "";
  try {
    const data = await api("/api/imagine/personalization?document=" + name, { method: "GET" });
    assertActive();
    target.content = data.content;
    target.savedContent = target.content;
    target.revision = data.revision;
    target.loaded = true;
    return true;
  } catch (loadError) {
    if (!controller.signal.aborted) target.error = translate("读取失败，请重试");
    return false;
  } finally {
    target.loading = false;
  }
}

async function reloadDocument(target: DocumentState, name: "agents" | "memory") {
  if (name === "memory" && memoryAction.value) return;
  if (isDirty(target)) {
    try {
      await ElMessageBox.confirm(translate("重新加载会丢弃未保存的修改。"), translate("重新加载"), {
        confirmButtonText: translate("放弃修改并加载"),
        cancelButtonText: translate("继续编辑"),
        type: "warning",
      });
    } catch {
      return;
    }
  }
  await loadDocument(target, name, true);
}

async function saveDocument(target: DocumentState, name: "agents" | "memory") {
  if (name === "memory" && memoryAction.value) return;
  if (!target.loaded || target.loading || target.saving || !isDirty(target)) return;
  target.saving = true;
  target.error = "";
  const content = target.content, revision = target.revision;
  try {
    const data = await api("/api/imagine/personalization", { method: "POST", body: JSON.stringify({ document: name, content, revision }) });
    assertActive();
    if (data.content !== content || data.revision === null) throw new Error("Unconfirmed save");
    target.savedContent = data.content;
    target.revision = data.revision;
    if (name === "memory" && !isDirty(target)) memoryEditing.value = false;
  } catch (saveError) {
    if (!controller.signal.aborted) target.error = saveError instanceof Error && "status" in saveError && saveError.status === 409
      ? translate("内容已被其他窗口修改，请重新加载后再保存") : translate("保存失败，请重试");
  } finally {
    target.saving = false;
  }
}

function setMemoryEnabled(value: boolean) {
  savingMemorySetting.value = true;
  updatePersonalizationSettings({ memoryEnabled: value });
  savingMemorySetting.value = false;
}

async function viewMemory() {
  if (memoryAction.value || memoryDocument.loading || memoryDocument.saving) return;
  memoryAction.value = "view";
  try {
    assertActive();
    if (!isDirty(memoryDocument)) {
      if (!await loadDocument(memoryDocument, "memory")) throw new Error("Memory unavailable");
      memoryEditing.value = false;
    }
    assertActive();
    memoryVisible.value = true;
  } catch (viewError) {
    if (!controller.signal.aborted) ElMessage.error(translate("读取失败，请重试"));
  } finally {
    memoryAction.value = "";
  }
}

async function deleteMemory() {
  if (memoryAction.value || memoryDocument.loading || memoryDocument.saving) return;
  memoryAction.value = "delete";
  try {
    try {
      await ElMessageBox.confirm(translate("创作记忆会被清空，无法恢复。"), translate("删除创作记忆"), {
        confirmButtonText: translate("删除"),
        cancelButtonText: translate("取消"),
        type: "warning",
      });
    } catch { return; }
    assertActive();
    if (!await loadDocument(memoryDocument, "memory", true)) throw new Error("Memory unavailable");
    memoryDocument.saving = true;
    const data = await api("/api/imagine/personalization", { method: "POST", body: JSON.stringify({ document: "memory", content: "", revision: memoryDocument.revision }) });
    assertActive();
    if (data.content !== "" || data.revision === null) throw new Error("Unconfirmed deletion");
    memoryDocument.content = "";
    memoryDocument.savedContent = "";
    memoryDocument.revision = data.revision;
    ElMessage.success(translate("创作记忆已删除"));
  } catch (deleteError) {
    if (!controller.signal.aborted) ElMessage.error(translate("删除记忆失败，请重试"));
  } finally {
    memoryDocument.saving = false;
    memoryAction.value = "";
  }
}

void loadDocument(document, "agents");
</script>

<style scoped lang="scss">
.personalization {
  display: flex;
  flex-direction: column;
  gap: var(--settings-gap-section);

  // 文本框到下面「字数 + 重新加载/保存」这行：控件 → 辅助信息，走 tight 档
  .editorFooter, .memoryFooter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: var(--settings-gap-tight);
  }

  .editorStatus {
    display: flex;
    gap: 10px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .editorActions {
    display: flex;
    gap: 8px;

    :deep(.el-button + .el-button) { margin-left: 0; }
  }

  :deep(.el-alert) { margin-bottom: var(--settings-gap-tight); }

  .memoryContent { min-height: 120px; max-height: 60vh; overflow: auto; }
}
</style>
