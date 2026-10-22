<template>
  <section class="extView" :aria-label="session.context.resource.label" @keydown.ctrl.s.capture.prevent="save" @keydown.meta.s.capture.prevent="save">
    <div v-if="session.context.error || runtimeError" class="extError" role="alert">
      <span>{{ session.context.error || runtimeError }}</span>
      <span class="errorActions">
        <el-button v-if="session.conflict" text size="small" @click="reloadDisk">{{ translate("载入磁盘版本") }}</el-button>
        <el-button v-if="session.context.dirty && session.canWriteText" text size="small" @click="saveCopy">{{ translate("另存副本") }}</el-button>
        <el-button v-if="runtimeError || session.context.dirty || !session.component" text size="small" @click="retry">{{ translate("重试") }}</el-button>
      </span>
    </div>
    <div v-loading="session.context.loading" class="extContent">
      <component :is="session.component" v-if="session.component && !runtimeError" :context="context" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onErrorCaptured, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { IDockviewPanelProps } from "dockview-vue";
import { translate } from "@miaoimg/i18n/vue";
import { createExtContext } from "../../../ext";
import { documentError, type EditorParams } from "../documentSession";
import { documentCopyPath, saveDocumentCopy } from "../documentCopy";
import type { WorkspaceFileCopier } from '@/pages/workspace/canvasFiles';

const props = defineProps<{ params: IDockviewPanelProps<EditorParams> }>();
const session = computed(() => props.params.params.session);
const copyCanvasFiles = inject<WorkspaceFileCopier>('copyWorkspaceFiles');
const lifetime = new AbortController();
onBeforeUnmount(() => lifetime.abort());
const visible = ref(props.params.api.isVisible);
const visibility = props.params.api.onDidVisibilityChange((event) => { visible.value = event.isVisible; });
onBeforeUnmount(() => visibility.dispose());
// 交给扩展的上下文分两层补齐：这里注入按视图走的前台状态与搜索定位，
// 扩展运行时（createExtContext）再补上工作区文件能力、配置与剪贴板。
const context = computed(() => createExtContext(new Proxy(session.value.context, {
  get(target, key, receiver) {
    if (key === "location") return props.params.params.view.location;
    if (key === "active") return visible.value && target.active;
    return Reflect.get(target, key, receiver);
  },
  has(target, key) {
    return key === "location" || Reflect.has(target, key);
  },
}) as unknown as Record<string, unknown>, session.value.extension.id, { copyCanvasFiles, signal: lifetime.signal }));

const runtimeError = ref("");
onErrorCaptured((error) => {
  runtimeError.value = error instanceof Error ? error.message : String(error);
  return false;
});

function save() {
  void context.value.flushSave().catch((error) => ElMessage.error(documentError(error)));
}

function retry() {
  if (runtimeError.value) { runtimeError.value = ""; return; }
  if (session.value.context.dirty) { save(); return; }
  session.value.ready = session.value.load();
  void session.value.ready.catch((error) => ElMessage.error(documentError(error)));
}

async function reloadDisk() {
  const current = session.value;
  const expectedText = current.context.text;
  try {
    await ElMessageBox.confirm(translate("将用磁盘内容替换当前未保存修改。需要保留当前内容时，请先另存副本。"), translate("载入磁盘版本"), {
      type: "warning",
      confirmButtonText: translate("载入"),
      cancelButtonText: translate("取消"),
    });
    lifetime.signal.throwIfAborted();
    if (session.value !== current) throw new Error(translate("文档已切换，请重新操作"));
    await current.reloadDisk(expectedText, lifetime.signal);
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(documentError(error));
  }
}

async function saveCopy() {
  const current = session.value;
  try {
    const suggested = documentCopyPath(current.context.resource);
    const { value } = await ElMessageBox.prompt(translate("输入工作区内的相对路径，不会覆盖同名文件。"), translate("另存副本"), {
      inputValue: suggested,
      inputValidator: (value) => !!value?.trim() || translate("请输入文件路径"),
      confirmButtonText: translate("保存"),
      cancelButtonText: translate("取消"),
    });
    const target = value.trim();
    lifetime.signal.throwIfAborted();
    if (session.value !== current) throw new Error(translate("文档已切换，请重新操作"));
    await saveDocumentCopy(current, target, lifetime.signal);
    ElMessage.success(translate("副本已保存"));
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(documentError(error));
  }
}
</script>

<style scoped lang="scss">
.extView {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--el-bg-color-overlay);

  .extError {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    color: var(--el-color-danger);
    background: var(--el-color-danger-light-9);
    font-size: 12px;
    overflow-wrap: anywhere;

    .errorActions {
      display: flex;
      flex-shrink: 0;
      flex-wrap: wrap;
    }
  }

  .extContent {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
}
</style>
