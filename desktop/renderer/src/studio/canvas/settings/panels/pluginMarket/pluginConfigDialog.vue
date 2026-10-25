<template>
  <el-dialog
    v-model="visible"
    :title="translate('插件配置') + (plugin ? ' · ' + (plugin.displayName || plugin.name) : '')"
    width="min(560px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!saving"
    :showClose="!saving">
    <el-form ref="configForm" :model="values" :rules="formRules" labelPosition="top" :disabled="saving" class="configForm">
      <el-form-item v-for="field in fields" :key="field.key" :label="field.label" :prop="field.key">
        <el-switch v-if="field.type === 'boolean'" v-model="values[field.key]" :aria-label="field.label" />
        <el-input-number
          v-else-if="field.type === 'number'"
          v-model="values[field.key]"
          :min="field.min"
          :max="field.max"
          :precision="0"
          controlsPosition="right"
          :aria-label="field.label" />
        <el-select v-else-if="field.type === 'select'" v-model="values[field.key]" :aria-label="field.label">
          <el-option v-for="option in field.options" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-input
          v-else
          v-model="values[field.key]"
          dir="ltr"
          :maxlength="field.maxLength"
          :placeholder="field.placeholder"
          :aria-label="field.label" />
        <p v-if="field.description" class="fieldHint">{{ field.description }}</p>
      </el-form-item>
    </el-form>
    <feedbackNotice v-if="formError" :message="formError"  />
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">{{ translate('取消') }}</el-button>
      <el-button :disabled="saving" @click="restoreDefaults">{{ translate('恢复默认值') }}</el-button>
      <el-button type="primary" :loading="saving" @click="save">{{ translate('保存') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import feedbackNotice from '../../../components/feedbackNotice.vue';
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";

export type ConfigRule = {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select";
  required?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  maxLength?: number;
  placeholder?: string;
  description?: string;
  default?: unknown;
};

type PluginLike = { name: string; displayName?: string; config?: Record<string, unknown>; configRules?: ConfigRule[] };

const props = defineProps<{ plugin?: PluginLike }>();
const emit = defineEmits<{ saved: [Record<string, unknown>] }>();
const visible = defineModel<boolean>({ default: false });

const configForm = ref<FormInstance>();
const values = reactive<Record<string, unknown>>({});
const saving = ref(false);
const formError = ref("");
let editSession: { name: string; scope: ReturnType<typeof captureWorkspaceScope>; controller: AbortController } | undefined;

function releaseEditor() {
  editSession?.controller.abort();
  editSession = undefined;
  saving.value = false;
}
onBeforeUnmount(releaseEditor);

const fields = computed<ConfigRule[]>(() => (Array.isArray(props.plugin?.configRules) ? props.plugin!.configRules! : []));

// 必填校验与声明一致；其余类型/范围由服务端再校验一次。
const formRules = computed<FormRules>(() => Object.fromEntries(fields.value.map(field => [
  field.key,
  field.required
    ? [{ required: true, message: translate("请填写「{0}」", { 0: field.label }), trigger: field.type === "boolean" ? "change" : "blur" }]
    : [],
])));

function defaults() {
  return Object.fromEntries(fields.value.map(field => [
    field.key,
    field.type === "boolean" ? field.default === true : field.default ?? (field.type === "number" ? undefined : ""),
  ]));
}

function restoreDefaults() {
  Object.assign(values, defaults());
  formError.value = "";
  void configForm.value?.clearValidate();
}

watch([visible, () => props.plugin], ([open]) => {
  releaseEditor();
  if (!open || !props.plugin) return;
  editSession = { name: props.plugin.name, scope: captureWorkspaceScope(), controller: new AbortController() };
  for (const key of Object.keys(values)) delete values[key];
  Object.assign(values, defaults(), props.plugin?.config ?? {});
  formError.value = "";
}, { immediate: true, flush: "sync" });

async function save() {
  const edit = editSession;
  if (!edit || saving.value) return;
  formError.value = "";
  const body = JSON.stringify({ name: edit.name, config: { ...values } });
  saving.value = true;
  try {
    if (!(await configForm.value?.validate().catch(() => false))) return;
    if (editSession !== edit || edit.controller.signal.aborted) return;
    assertWorkspaceScope(edit.scope);
    const response = await fetch("/api/nodes/config", {
      method: "POST",
      credentials: "same-origin",
      headers: { "x-miaoimg-workspace": "1", "content-type": "application/json" },
      body,
      signal: AbortSignal.any([edit.controller.signal, AbortSignal.timeout(30_000)]),
    });
    if (editSession !== edit || edit.controller.signal.aborted) { await response.body?.cancel().catch(() => {}); return; }
    try { assertWorkspaceScope(edit.scope); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    const data = await response.json().catch(() => undefined);
    if (editSession !== edit || edit.controller.signal.aborted) return;
    assertWorkspaceScope(edit.scope);
    if (!response.ok) throw new Error(data?.error || data?.message || translate("请求失败（{0}）", { 0: response.status }));
    if (data?.code !== 200 || data.data?.name !== edit.name || !data.data.config || typeof data.data.config !== "object" || Array.isArray(data.data.config)) throw new Error(translate("操作结果尚未确认，请保留当前内容并核对后再继续"));
    emit("saved", data.data.config);
    // 画布监听这个事件后会重新拉 /api/nodes/get，节点读到的配置随之更新。
    window.dispatchEvent(new CustomEvent("miaoimg:node-config-updated"));
    visible.value = false;
    ElMessage.success(translate("配置已保存"));
  } catch (error) {
    if (editSession === edit && !edit.controller.signal.aborted) formError.value = error instanceof Error ? error.message : translate("保存配置失败");
  } finally {
    if (editSession === edit) saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.configForm {
  :deep(.el-form-item) { margin-bottom: 18px; }
  :deep(.el-select),
  :deep(.el-input-number) { width: 100%; }

  .fieldHint {
    margin: 6px 0 0;
    font-size: 12px;
    line-height: 1.6;
    color: var(--el-text-color-secondary);
  }
}
</style>
