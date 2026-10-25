<template>
  <el-dialog
    v-model="visible"
    :title="translate('扩展配置') + (extension ? ' · ' + (extension.displayName || extension.id) : '')"
    width="min(560px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    destroyOnClose>
    <el-form labelPosition="top" class="configForm" :disabled="saving" @submit.prevent>
      <el-form-item v-for="field in fields" :key="field.field" :label="translate(field.title || field.field)">
        <el-input-number v-if="field.type === 'inputNumber'" v-model="values[field.field]" :min="minOf(field)" :max="maxOf(field)" :step="stepOf(field)" :aria-label="translate(field.title || field.field)" />
        <el-switch v-else-if="field.type === 'switch'" v-model="values[field.field]" :aria-label="translate(field.title || field.field)" />
        <el-input v-else v-model="values[field.field]" dir="ltr" :aria-label="translate(field.title || field.field)" />
      </el-form-item>
    </el-form>
    <feedbackNotice v-if="formError" :message="formError"  />
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">{{ translate("取消") }}</el-button>
      <el-button :disabled="saving" @click="restoreDefaults">{{ translate("恢复默认值") }}</el-button>
      <el-button type="primary" :loading="saving" @click="save">{{ translate("保存") }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import feedbackNotice from '../../../components/feedbackNotice.vue';
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import { saveExtensionConfig, type InstalledExtension } from "@/studio/canvas/ext";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";

// 扩展的配置规则沿用表单规则数组（field / title / type / value / props），
// 服务端只认 inputNumber 与 switch 两种标准控件，这里按同一口径渲染。
type ExtRule = { field: string; title?: string; type?: string; value?: unknown; props?: { min?: number; max?: number; step?: number } };

const props = defineProps<{ extension?: InstalledExtension }>();
const visible = defineModel<boolean>({ default: false });

const values = reactive<Record<string, unknown>>({});
const saving = ref(false);
const formError = ref("");
let editSession: { id: string; scope: ReturnType<typeof captureWorkspaceScope>; controller: AbortController } | undefined;

function releaseEditor() {
  editSession?.controller.abort();
  editSession = undefined;
  saving.value = false;
}
onBeforeUnmount(releaseEditor);

// 规则可能嵌在布局里，取字段时一路收全，和服务端保存时的口径一致。
const fields = computed<ExtRule[]>(() => {
  const found: ExtRule[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const rule of list) {
      if (!rule || typeof rule !== "object") continue;
      const item = rule as ExtRule & { children?: unknown; control?: { rule?: unknown }[] };
      if (typeof item.field === "string" && item.field) found.push(item);
      walk(item.children);
      if (Array.isArray(item.control)) for (const control of item.control) walk(control?.rule);
    }
  };
  walk(props.extension?.configRules);
  return found;
});

const minOf = (field: ExtRule) => typeof field.props?.min === "number" ? field.props.min : undefined;
const maxOf = (field: ExtRule) => typeof field.props?.max === "number" ? field.props.max : undefined;
const stepOf = (field: ExtRule) => typeof field.props?.step === "number" ? field.props.step : undefined;

function defaults() {
  return Object.fromEntries(fields.value.map(field => [
    field.field,
    field.type === "switch" ? field.value === true : field.value ?? (field.type === "inputNumber" ? 0 : ""),
  ]));
}

function restoreDefaults() {
  Object.assign(values, defaults());
  formError.value = "";
}

watch([visible, () => props.extension], ([open]) => {
  releaseEditor();
  if (!open || !props.extension) return;
  editSession = { id: props.extension.id, scope: captureWorkspaceScope(), controller: new AbortController() };
  for (const key of Object.keys(values)) delete values[key];
  Object.assign(values, defaults(), props.extension?.config ?? {});
  formError.value = "";
}, { immediate: true, flush: "sync" });

async function save() {
  const edit = editSession;
  if (!edit || saving.value) return;
  formError.value = "";
  saving.value = true;
  try {
    assertWorkspaceScope(edit.scope);
    await saveExtensionConfig(edit.id, { ...values }, edit.controller.signal);
    if (editSession !== edit || edit.controller.signal.aborted) return;
    assertWorkspaceScope(edit.scope);
    visible.value = false;
    ElMessage.success(translate("配置已保存"));
  } catch (error) {
    const response = (error as { response?: { data?: { error?: string; message?: string } } })?.response;
    if (editSession === edit && !edit.controller.signal.aborted) formError.value = response?.data?.error || response?.data?.message || (error instanceof Error ? error.message : translate("保存配置失败"));
  } finally {
    if (editSession === edit) saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.configForm {
  :deep(.el-form-item) { margin-bottom: 18px; }
  :deep(.el-input-number) { width: 100%; }
}
</style>
