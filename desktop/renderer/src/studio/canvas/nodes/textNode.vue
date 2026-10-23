<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :modelLabel="nodeLocalModelLabel(model)"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="downloadUrl"
    :downloadName="`${nodeProps.label || translate('文本')}.md`"
    :bottomWidth="660"
    @fullscreen="fullscreen = true; editing = true">
    <template v-if="inlineEditing" #top>
      <!-- 节点上直接编辑时的浮动工具栏，按 LibTV 的顺序：背景色、段落样式、粗体、斜体、分割线、展开编辑。 -->
      <el-card class="mediaToolbar textFormatBar" shadow="never" :bodyStyle="{ padding: '6px' }" @mousedown.prevent>
        <el-popover trigger="click" placement="bottom-start" :width="212" :persistent="false" :showArrow="false">
          <template #reference>
            <button type="button" class="formatButton" :title="translate('背景色')" :aria-label="translate('背景色')"><span class="colorDot" :style="{ background: backgroundColor || 'var(--el-text-color-placeholder)' }" /></button>
          </template>
          <div class="colorGrid" role="listbox" :aria-label="translate('背景色')">
            <button v-for="color in TEXT_BACKGROUNDS" :key="color || 'none'" type="button" role="option" :aria-selected="backgroundColor === color" :class="{ none: !color, active: backgroundColor === color }"
              :style="{ background: color || 'transparent' }" :aria-label="color ? color : translate('无背景色')" @click="backgroundColor = color" />
          </div>
        </el-popover>
        <span class="formatDivider" />
        <el-dropdown trigger="click" :persistent="false" @command="(block: string) => inlineEditor?.command(block as TextBlockName)">
          <button type="button" class="formatButton blockButton" :aria-label="translate('段落样式')"><icon-typography :size="17" />{{ translate(blockLabel) }}<icon-chevron-down :size="13" /></button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="item in TEXT_BLOCKS" :key="item.value" :command="item.value">
                <span class="blockOption"><span class="blockMark">{{ item.mark }}</span>{{ translate(item.label) }}<icon-check v-if="activeBlock === item.value" :size="14" /></span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <span class="formatDivider" />
        <button type="button" class="formatButton" :title="translate('粗体')" :aria-label="translate('粗体')" @click="inlineEditor?.command('bold')"><icon-bold :size="17" /></button>
        <button type="button" class="formatButton" :title="translate('斜体')" :aria-label="translate('斜体')" @click="inlineEditor?.command('italic')"><icon-italic :size="17" /></button>
        <button type="button" class="formatButton" :title="translate('分割线')" :aria-label="translate('分割线')" @click="inlineEditor?.command('rule')"><icon-minus :size="17" /></button>
        <span class="formatDivider" />
        <button type="button" class="formatButton" :title="translate('展开编辑')" :aria-label="translate('展开编辑')" @click="expandEditor"><icon-arrows-diagonal :size="17" /></button>
      </el-card>
    </template>
    <div class="textContent" :class="{ empty: !outputs.text.value.trim() && !inlineEditing, tinted: !!backgroundColor }" :style="backgroundColor ? { '--textNodeTint': backgroundColor } : undefined" @dblclick.stop="startInlineEdit">
      <el-alert v-if="documentError" :title="documentError" type="error" :closable="false" showIcon>
        <el-button text size="small" :disabled="generating || textReloading" @click="editing = true">{{ translate('查看并复制当前正文') }}</el-button>
        <el-button text size="small" :disabled="generating" :loading="textReloading" @click="reloadText()">{{ translate('重新读取磁盘') }}</el-button>
      </el-alert>
      <markdownEditor v-if="inlineEditing" ref="inlineEditor" inline class="inlineEditor nodrag nopan nowheel" v-model="outputs.text.value" :files="textReady ? textFiles : undefined" :path="textPath" :active="inlineEditing"
        :disabled="generating || textReloading" :readonly="!!documentError" :ariaLabel="translate('编辑文本内容')" @keydown.esc.stop="inlineEditing = false" />
      <template v-else>
        <div v-if="outputs.text.value.trim() && previewReady" class="textPreview nopan nowheel" :aria-label="translate('文本内容')">
          <markdownPreview :modelValue="outputs.text.value" :files="textReady ? textFiles : undefined" :path="textPath" :active="previewReady" />
        </div>
        <nodeEmptyState v-if="!outputs.text.value.trim()" :icon="IconFileText" :label="translate('暂无文本')" :hints="emptyHints" :disabled="generating || !textReady" @pick="pickHint" />
        <el-button v-else class="editButton nodrag nopan" :icon="IconEdit" :disabled="generating || !textReady" text @dblclick.stop @click.stop="startInlineEdit">{{ translate('编辑') }}</el-button>
      </template>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <div class="promptHeader" v-if="refList.length">
          <referenceItem
            v-model="refList"
            @preview="setReferencePreview"
            @remove="removeReference" />
        </div>
        <promptInput v-model="promptModel" v-model:text="prompt" :references="referenceMentions" placeholder="写下你想讲的故事、场景或角色设定，例如：一个来自未来的机器人，在城市屋顶看星星。输入 @ 引用素材" />
        <div class="promptFooter">
          <el-select v-model="model" class="modelSelect" filterable :loading="modelsLoading" :disabled="generating" :placeholder="translate('选择模型')" :aria-label="translate('生成模型')" :noDataText="translate('暂无可用模型')" placement="top-start" @visible-change="visible => visible && loadModels()">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="group in groupNodeModels(models)" :key="group.id" :label="group.label">
              <el-option v-for="item in group.models" :key="JSON.stringify([item.providerId, item.modelId])" :label="nodeModelOptionLabel(item)" :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <div class="promptActions">
            <el-tag v-if="['doubao-local', 'dola-local'].includes(selectedModel?.providerId || '')" size="small" effect="plain">{{ selectedModel?.providerId === 'dola-local' ? translate('使用 Dola 额度') : translate('使用豆包额度') }}</el-tag>
            <span v-if="data.pendingLocalTextTask && !generating" role="status">{{ translate('原任务待取回') }}</span>
            <span v-if="generating && localTextStatus" role="status">{{ localTextStatus }}</span>
            <el-button class="sendButton" :icon="IconArrowUp" :loading="generating" :disabled="(!data.pendingLocalTextTask && (!prompt.trim() || !selectedModel)) || modelsLoading || generating || !textReady || !!documentError" :title="translate(data.pendingLocalTextTask ? '继续取回原文本任务' : '生成')" :aria-label="translate(data.pendingLocalTextTask ? '继续取回原文本任务' : '生成')" @click="generateText().catch(() => {})" />
          </div>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <el-dialog v-model="editing" :title="nodeProps.label || translate('编辑文本')" width="min(860px, calc(100vw - 32px))" :fullscreen="fullscreen" alignCenter appendToBody @closed="fullscreen = false">
    <div class="textEditor" :class="{ fullscreen }">
      <markdownEditor v-model="outputs.text.value" :files="textReady ? textFiles : undefined" :path="textPath" :active="editing" :disabled="generating || textReloading" :readonly="!!documentError" :ariaLabel="translate('编辑文本内容')" />
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { groupNodeModels, pendingMediaTaskError } from '../scaffold/nodeAi';
import { nodeLocalModelLabel, nodeModelOptionLabel } from '../scaffold/localModelLabel';
import { isNodeOutput, type NodeOutput } from "@miaoimg/nodes-scaffold/values";
import { computed, inject, nextTick, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useVueFlow } from '@vue-flow/core';
import { ElAlert, ElButton, ElCard, ElSelect, ElDialog, ElOption, ElMessage, ElMessageBox, ElPopover, ElDropdown, ElDropdownMenu, ElDropdownItem } from "element-plus";
import { IconEdit, IconFileText, IconPhotoAi, IconVideo, IconSparkles, IconArrowUp, IconTypography, IconChevronDown, IconCheck, IconBold, IconItalic, IconMinus, IconArrowsDiagonal } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNodeGeneration, useNode, useNodeReferences, z, type NodeAiModel, type NodeHandle } from "@miaoimg/nodes-scaffold/runtime";
import referenceItem from "@miaoimg/nodes-scaffold/referenceItem";
import promptInput from "@miaoimg/nodes-scaffold/promptInput";
import { translate } from "@miaoimg/i18n/vue";
import { throttle } from "lodash-es";
import markdownEditor from "./textNode/markdownEditor.vue";
import nodeEmptyState, { type EmptyHint } from "../components/nodeEmptyState.vue";
import { useLinkedNode } from "../linkedNode";
import markdownPreview from "./textNode/markdownPreview.vue";
import { useNodeDocumentState } from "@miaoimg/nodes-scaffold/nodeDocument";
import { isWorkspacePath } from '../../../../../../server/workspace-path';
import { canvasTextSnapshotPaths } from '../../../../../../server/canvas-text-snapshot.ts';
import { captureWorkspaceScope, DEFAULT_PROJECT } from '@/lib/workspaceRemote';

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;

defineOptions({
  inheritAttrs: false,
  icon: IconFileText,
  handles: [
    { id: "in", type: "target", dataType: ["VIDEO", "IMAGE", "STRING"], label: "视频、图片、文本输入" },
    { id: "text", type: "source", dataType: "STRING", label: "文本输出" },
  ] satisfies NodeHandle[],
});
const { node, nodeProps, outputs, ai, files, nodeEvent, previewReady } = useNode({
  label: "文本",
  outputs: { text: { dataType: "STRING", value: "" } },
});
const { refList, referenceMentions, preparePromptReferences, setReferencePreview, removeReference } = useNodeReferences();
const flow = useVueFlow();
const persistTaskBinding = inject<(() => Promise<void>) | undefined>('persistCanvasTaskBinding', undefined);
const getCanvasSignal = inject<(() => AbortSignal) | undefined>('canvasOperationSignal', undefined);
const editing = ref(false);
const fullscreen = ref(false);
// 双击节点或点「编辑」就在节点上直接改，像 LibTV 一样；取消选中或按 Esc 退出。
const inlineEditing = ref(false);
const inlineEditor = ref<InstanceType<typeof markdownEditor>>();
type TextBlockName = "paragraph" | "h1" | "h2" | "h3" | "ordered" | "bullet";
const TEXT_BLOCKS: { value: TextBlockName; label: string; mark: string }[] = [
  { value: "paragraph", label: "正文", mark: "T" }, { value: "h1", label: "标题", mark: "H1" }, { value: "h2", label: "小标题", mark: "H2" },
  { value: "h3", label: "副标题", mark: "H3" }, { value: "ordered", label: "有序列表", mark: "1." }, { value: "bullet", label: "无序列表", mark: "•" },
];
const TEXT_BACKGROUNDS = ["", "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899", "#737373"];
const activeBlock = computed(() => inlineEditor.value?.activeBlock ?? "paragraph");
const blockLabel = computed(() => TEXT_BLOCKS.find(item => item.value === activeBlock.value)?.label ?? "正文");
function startInlineEdit() {
  if (generating.value || !textReady.value) return;
  if (documentError.value) { editing.value = true; return; }
  flow.removeSelectedElements();
  flow.addSelectedNodes([node]);
  inlineEditing.value = true;
  void nextTick(() => inlineEditor.value?.focus());
}
const { canLink, createLinked } = useLinkedNode();
const emptyHints = computed<EmptyHint[]>(() => [
  { key: "write", label: "自己编写内容", icon: IconEdit },
  { key: "ai", label: "让 AI 来写", icon: IconSparkles },
  ...(canLink(node, "remote-imageGenerationNode") ? [{ key: "image", label: "文生图片", icon: IconPhotoAi }] : []),
  ...(canLink(node, "remote-videoGenerationNode") ? [{ key: "video", label: "文生视频", icon: IconVideo }] : []),
]);
function pickHint(key: string) {
  if (key === "write") return startInlineEdit();
  if (key === "image") return void createLinked(node, "remote-imageGenerationNode", "图片生成");
  if (key === "video") return void createLinked(node, "remote-videoGenerationNode", "视频生成");
  flow.removeSelectedElements();
  flow.addSelectedNodes([node]);
  void nextTick(() => document.querySelector<HTMLElement>(`.vue-flow__node[data-id="${CSS.escape(node.id)}"] .promptInput [contenteditable="true"]`)?.focus());
}
function expandEditor() { inlineEditing.value = false; fullscreen.value = true; editing.value = true; }
watch(() => node.selected, selected => { if (!selected) inlineEditing.value = false; });
const localTextStatus = ref('');
const downloadUrl = ref("");
watch([() => outputs.value.text.value, () => node.selected], ([text, selected], _previous, onCleanup) => {
  downloadUrl.value = "";
  if (!selected || !text.trim()) return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  downloadUrl.value = url;
  onCleanup(() => URL.revokeObjectURL(url));
}, { immediate: true });
const data = computed(() => node.data as typeof node.data & { background?: string; prompt?: string; promptModel?: PromptModel; model?: string; textPath?: string; textSnapshot?: string; textSnapshotPath?: string; textSnapshotPaths?: Record<string, string>; pendingLocalTextTask?: { id: string; providerId: string; modelId: string } });
const backgroundColor = computed({ get: () => data.value.background ?? "", set: (value: string) => { data.value.background = value || undefined; } });
const prompt = computed({ get: () => data.value.prompt ?? "", set: (value: string) => { data.value.prompt = value; } });
const model = computed({ get: () => data.value.model ?? "", set: (value: string) => { data.value.model = value; } });
const models = ref<NodeAiModel[]>([]);
const modelsLoading = ref(false);
let textController: AbortController | undefined;
let textJob: Promise<unknown> | undefined;
const textGeneration = useNodeGeneration(outputs, () => textController?.abort(), value => {
  const text = value.text?.dataType === 'STRING' ? value.text.value : '';
  return { text: { dataType: 'STRING', value: text.slice(0, 1000), path: textPath, totalLength: text.length, truncated: text.length > 1000 } };
}, () => ({ phase: "running", message: localTextStatus.value, requestId: data.value.pendingLocalTextTask?.id }));
const generating = textGeneration.generating;
watch(generating, value => { if (value) inlineEditing.value = false; });
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === model.value));
const textReady = ref(false);
const textReloading = ref(false);
const documentError = ref("");
const textPath = `assets/${node.id}/content.md`;
function markExternalTextOutputs() {
  if (!Object.hasOwn(outputs.value, "toJSON")) Object.defineProperty(outputs.value, "toJSON", {
    value: () => textReady.value ? {} : { text: { dataType: 'STRING', value: outputs.value.text.value } },
  });
}
// Explicit output edits can replace the wrapper through useNode. Keep the
// external-body contract on every loaded wrapper, including later merges.
watch(outputs, () => { if (textReady.value) markExternalTextOutputs(); }, { flush: "sync" });
let textFiles: ReturnType<typeof files.getWorkspaceFiles>;
let textLoading: Promise<boolean> | undefined;
let textReloadRequest: Promise<void> | undefined;
let textSaving = Promise.resolve();
let textRevision = 0;
let textFileRevision = "";
let textSaveEpoch = 0;
const savedText = ref<string>();
const documentState = useNodeDocumentState();
watch([() => outputs.value.text.value, savedText, documentError], () => {
  documentState.dirty = outputs.value.text.value !== savedText.value;
  documentState.error = documentError.value;
}, { immediate: true, flush: "sync" });
function saveText(value: string) {
  const revision = ++textRevision;
  const epoch = textSaveEpoch;
  textSaving = textSaving.catch(() => {}).then(async () => {
    if (epoch !== textSaveEpoch) return;
    if (data.value.textPath !== undefined && data.value.textPath !== textPath) throw new Error(translate("文本文件路径无效"));
    if (!textFiles) throw new Error(translate("文本尚未加载，无法保存"));
    textFileRevision = await textFiles.writeText(textPath, value, textFileRevision);
    savedText.value = value;
    if (revision === textRevision && outputs.value.text.value === value) documentError.value = "";
  }).catch(error => {
    documentError.value = (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      || (error instanceof Error ? error.message : translate("文本保存失败"));
    throw error;
  });
  return textSaving;
}
nodeEvent.on("save", async (reason) => {
  await textReloadRequest;
  await textLoading;
  // A failed load has no editable document to flush. Keep the inline draft in
  // the graph so that saving, deleting or undoing the broken node can recover.
  if (!textReady.value) {
    if (documentError.value) return;
    throw new Error(translate("文本尚未加载，无法保存"));
  }
  if (reason === "reload" && generating.value) throw new Error(translate("文本正在生成，请完成后再刷新节点"));
  // 普通编辑已由 watcher 入队；生成中补存当前片段，不因画布保存重复写未改动的文本。
  if (generating.value) saveText(outputs.value.text.value);
  let pending: Promise<void>;
  do {
    pending = textSaving;
    try { await pending; }
    catch { await saveText(outputs.value.text.value); }
    if (pending === textSaving && !generating.value && outputs.value.text.value !== savedText.value) {
      await saveText(outputs.value.text.value);
    }
  } while (pending !== textSaving);
  if (reason === "reload" && generating.value) throw new Error(translate("文本正在生成，请完成后再刷新节点"));
});
onMounted(() => { textLoading = loadText(); });
async function loadText(fromDisk = false, signal?: AbortSignal, expectedText?: string) {
  textReloading.value = true;
  textReady.value = false;
  try {
    signal?.throwIfAborted();
    if (!node.id || /[\\/]/.test(node.id) || node.id === "." || node.id === "..") throw new Error(translate("节点 ID 不能作为文件夹名称"));
    if (data.value.textPath !== undefined && data.value.textPath !== textPath) throw new Error(translate("文本文件路径无效"));
    textFiles = files.getWorkspaceFiles();
    const scope = { ...captureWorkspaceScope(), defaultProject: DEFAULT_PROJECT, origin: window.location.origin };
    const migration = { text: data.value.textSnapshot, path: data.value.textSnapshotPath,
      paths: JSON.stringify(data.value.textSnapshotPaths), canonical: data.value.textPath };
    const assertMigration = () => {
      if (data.value.textSnapshot !== migration.text || data.value.textSnapshotPath !== migration.path
        || JSON.stringify(data.value.textSnapshotPaths) !== migration.paths || data.value.textPath !== migration.canonical) {
        throw new Error(translate('文本副本已变化，请重新加载节点'));
      }
    };
    let snapshot = data.value.textPath || fromDisk ? await textFiles.readTextSnapshot(textPath, signal) : undefined;
    assertMigration();
    const stored = snapshot?.text;
    let value = fromDisk ? stored! : migration.text !== undefined ? migration.text : stored ?? outputs.value.text.value;
    if (typeof value !== "string") throw new Error(translate("文本内容无效"));
    if (!fromDisk && migration.text !== undefined) {
      const sourcePath = migration.path ?? textPath;
      if (!isWorkspacePath(sourcePath) || /^[a-z][a-z\d+.-]*:/i.test(sourcePath)) throw new Error(translate('文本文件路径无效'));
      const paths = canvasTextSnapshotPaths(data.value);
      if (value.includes('[') || value.includes('<')) {
        const { rebaseMarkdownPaths } = await import('./textNode/rebaseMarkdownPaths');
        value = rebaseMarkdownPaths(value, sourcePath, textPath, {
          scope, mapPath: path => paths.get(path) ?? (path === sourcePath ? textPath : path),
        });
      }
    }
    signal?.throwIfAborted();
    assertMigration();
    // A failed migration must still leave the restored draft visible to copy.
    // textReady stays false until persistence succeeds, so this cannot autosave.
    if (fromDisk && expectedText !== undefined && outputs.value.text.value !== expectedText) throw new Error(translate("文档内容已变化，请重新读取后编辑"));
    if (!fromDisk) outputs.value.text.value = value;
    if (!data.value.textPath && !fromDisk) {
      // 写入会创建父目录，无需为每个节点重复创建共享 assets 目录。
      // ACT: 只新建不覆盖；文件已存在时读回比对，避免把磁盘上别处的正文冲掉。
      await textFiles.write(textPath, value, true).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
      });
      snapshot = await textFiles.readTextSnapshot(textPath);
      if (snapshot.text !== value) throw new Error(translate("文本文件已被其他编辑器修改，请重新加载节点"));
    } else if (stored !== undefined && stored !== value) {
      // 旧数据把正文留在节点数据里：磁盘内容不同时以节点数据为准落盘。
      snapshot = { text: value, revision: await textFiles.writeText(textPath, value, snapshot!.revision) };
    }
    assertMigration();
    textFileRevision = snapshot!.revision;
    savedText.value = value;
    outputs.value.text.value = value;
    data.value.textPath = textPath;
    delete data.value.textSnapshot;
    delete data.value.textSnapshotPath;
    delete data.value.textSnapshotPaths;
    // ACT: 成功落盘后才排除内联正文；迁移失败时画布仍保留原内容。
    markExternalTextOutputs();
    textSaving = Promise.resolve();
    textReady.value = true;
    documentError.value = "";
    return true;
  } catch (error) {
    documentError.value = (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      || (error instanceof Error ? error.message : translate("文本加载失败"));
    if (!signal?.aborted) ElMessage.error(documentError.value);
    return false;
  } finally { textReloading.value = false; }
}

async function reloadText(skipConfirm = false, diskOnly = false, signal?: AbortSignal) {
  if (generating.value || textReloading.value) return;
  const expectedText = outputs.value.text.value;
  const confirmed = skipConfirm || await ElMessageBox.confirm(translate("重新读取将用磁盘内容替换当前正文。未保存的修改会被放弃，请先复制需要保留的内容。"), translate("重新读取文本"), {
    confirmButtonText: translate("重新读取"), cancelButtonText: translate("取消"), type: "warning", closeOnClickModal: false,
  }).then(() => true, () => false);
  signal?.throwIfAborted();
  if (!confirmed || generating.value || textReloading.value) return;
  if (outputs.value.text.value !== expectedText) throw new Error(translate("文档内容已变化，请重新读取后编辑"));
  const fromDisk = diskOnly || textReady.value || !!data.value.textPath;
  const previousReady = textReady.value;
  let beforeReadError: string | undefined;
  let loaded = false;
  textReloading.value = true;
  textReady.value = false;
  // Queued writes not yet sent belong to the discarded version. An already
  // submitted write must settle before reading its actual resulting file.
  textSaveEpoch++;
  const request = (async () => {
    try {
      await textSaving.catch(() => {});
      signal?.throwIfAborted();
      beforeReadError = documentError.value;
      textLoading = loadText(fromDisk, signal, expectedText);
      loaded = await textLoading;
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted && !loaded) {
        textReady.value = previousReady;
        if (beforeReadError !== undefined) documentError.value = beforeReadError;
      }
      throw error;
    } finally { textReloading.value = false; }
  })();
  textReloadRequest = request;
  try { await request; }
  finally { if (textReloadRequest === request) textReloadRequest = undefined; }
}

watch(() => outputs.value.text.value, async (value) => {
  if (!textReady.value || generating.value) return;
  try { await saveText(value); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : translate("文本保存失败")); }
}, { flush: "sync" });
nodeEvent.on("copy", async () => {
  await textLoading;
  if (!textReady.value) throw new Error(documentError.value || translate("文本尚未加载"));
  return { textPath: undefined, textSnapshot: outputs.value.text.value, textSnapshotPath: textPath, textSnapshotPaths: undefined, pendingLocalTextTask: undefined };
});

nodeEvent.on('delete', async () => {
  const pending = textJob;
  if (!pending) return;
  textController?.abort();
  await pending.catch(() => {});
  if (documentError.value) throw new Error(documentError.value);
});

onMounted(() => { void loadModels(); });
let disposed = false;
let modelRequest: Promise<boolean> | undefined;
function refreshVisibleModels() {
  if (node.selected && !generating.value && document.visibilityState === "visible") void loadModels(true);
}
onMounted(() => {
  window.addEventListener("focus", refreshVisibleModels);
  document.addEventListener("visibilitychange", refreshVisibleModels);
});
onBeforeUnmount(() => {
  disposed = true;
  textController?.abort();
  window.removeEventListener("focus", refreshVisibleModels);
  document.removeEventListener("visibilitychange", refreshVisibleModels);
});
watch(() => node.selected, (selected, _previous, cleanup) => {
  if (!selected) return;
  refreshVisibleModels();
  const timer = window.setInterval(refreshVisibleModels, 30000);
  cleanup(() => window.clearInterval(timer));
}, { immediate: true });

function loadModels(silent = false): Promise<boolean> {
  if (modelRequest) return modelRequest;
  modelsLoading.value = true;
  modelRequest = (async () => { try {
    const available = await ai.getModels();
    if (disposed) return false;
    models.value = available;
    if (!available.some(item => JSON.stringify([item.providerId, item.modelId]) === model.value)) {
      const first = models.value[0];
      model.value = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
    return true;
  } catch (error) {
    if (disposed) return false;
    models.value = [];
    if (!silent && error instanceof Error && error.name !== "AbortError") ElMessage.error(error.message);
    return false;
  } finally {
    modelsLoading.value = false;
    modelRequest = undefined;
  } })();
  return modelRequest;
}

async function generateText() {
  if (documentError.value) throw new Error(documentError.value);
  if (!textReady.value || generating.value || (!data.value.pendingLocalTextTask && (!selectedModel.value || !prompt.value.trim()))) return;
  // A restored canvas can reuse this component after replacing its lifetime.
  // Bind each generation to the current canvas, while retaining that signal
  // throughout the call so a later reload still stops the old observer.
  const canvasSignal = getCanvasSignal?.();
  const pending = textGeneration.run(async () => {
  const requestedModel = model.value;
  const controller = textController = new AbortController();
  let text = "";
  let localRequestId = data.value.pendingLocalTextTask?.id;
  let finishedRequestId: string | undefined;
  localTextStatus.value = '';
  const publish = throttle(() => { outputs.value.text.value = text; }, 50);
  function assertCurrent() {
    controller.signal.throwIfAborted();
    canvasSignal?.throwIfAborted();
    if (disposed || flow.findNode(node.id) !== node) throw new Error(translate('画布节点已变化，请重新操作'));
  }
  try {
    await textSaving;
    // Taking back an existing result does not depend on today's draft,
    // references or model catalogue. Those only validate a new generation.
    if (!data.value.pendingLocalTextTask && !await loadModels()) throw new Error("模型读取失败");
    assertCurrent();
    const pendingLocal = data.value.pendingLocalTextTask;
    if (pendingLocal && (typeof pendingLocal.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(pendingLocal.id)
      || !['doubao-local', 'dola-local'].includes(pendingLocal.providerId)
      || typeof pendingLocal.modelId !== 'string' || !(pendingLocal.modelId === pendingLocal.providerId + '-text' || pendingLocal.modelId.startsWith(pendingLocal.providerId + '-text-')))) throw new Error(translate('原文本任务绑定无效，请检查原任务记录；尚未重新生成。'));
    const choice = pendingLocal || selectedModel.value;
    if (!choice || !pendingLocal && model.value !== requestedModel) throw new Error(translate("原模型已不可用，请确认模型后重试"));
    if (!pendingLocal) preparePromptReferences();
    if (!pendingLocal && refList.value.some(item => item.value === undefined)) throw new Error(translate("引用节点暂无内容，请先补充引用内容"));
    const references = pendingLocal ? [] : refList.value
      .filter((item): item is typeof item & Extract<NodeOutput, { dataType: "STRING" | "IMAGE" | "VIDEO" }> => isNodeOutput(item) && (item.dataType === "STRING" || item.dataType === "IMAGE" || item.dataType === "VIDEO"))
      .map(item => item.dataType === "STRING" ? { dataType: item.dataType, value: item.value } : { dataType: item.dataType, value: { ...item.value } });
    const input = { providerId: choice.providerId, modelId: choice.modelId, prompt: prompt.value.trim(), references };
    const directory = references.some(item => item.dataType !== "STRING") ? (await textFiles.list()).directory : undefined;
    const result = await ai.generate({
      ...input,
      directory,
      outputDirectory: `assets/${node.id}`,
      taskId: pendingLocal?.id,
      async onTask(requestId, existing = false) {
        assertCurrent();
        if (data.value.pendingLocalTextTask && data.value.pendingLocalTextTask.id !== localRequestId && data.value.pendingLocalTextTask.id !== requestId) throw new Error(translate('原文本任务已变化，请重新读取'));
        localRequestId = requestId;
        data.value.pendingLocalTextTask = { id: requestId, providerId: choice.providerId, modelId: choice.modelId };
        try {
          if (!persistTaskBinding) throw new Error(translate('画布尚未就绪，无法保存生成任务'));
          await persistTaskBinding();
          assertCurrent();
          if (data.value.pendingLocalTextTask?.id !== requestId) throw new Error(translate('原文本任务已变化，请重新读取'));
        } catch (error) {
          if (!existing && data.value.pendingLocalTextTask?.id === requestId) delete data.value.pendingLocalTextTask;
          throw error;
        }
      },
      onTaskFinished: requestId => { finishedRequestId = requestId; },
      signal: controller.signal,
      onEvent(event) {
        if (localRequestId) {
          assertCurrent();
          if (data.value.pendingLocalTextTask?.id !== localRequestId) throw new Error(translate('原文本任务已变化，请重新读取'));
        }
        if (event.type === "text") { text += event.delta; publish(); }
        if (event.type === 'status' && ['doubao-local', 'dola-local'].includes(choice.providerId)) localTextStatus.value = event.message;
      },
    });
    if (result.requestId) assertCurrent();
    publish.flush();
    outputs.value.text.value = result.text;
    finishedRequestId = result.requestId;
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") ElMessage.error(error.message);
    throw error;
  } finally {
    publish.flush(); publish.cancel();
    // 卸载会取消请求并停止 watcher，生成收尾必须自行保存已收到的正文。
    try {
      await saveText(outputs.value.text.value);
      if (finishedRequestId && data.value.pendingLocalTextTask?.id === finishedRequestId && !disposed && flow.findNode(node.id) === node) {
        const binding = data.value.pendingLocalTextTask;
        delete data.value.pendingLocalTextTask;
        try {
          if (!persistTaskBinding) throw new Error(translate('画布尚未就绪，无法保存生成任务'));
          await persistTaskBinding();
        } catch (error) {
          if (!data.value.pendingLocalTextTask) data.value.pendingLocalTextTask = binding;
          throw error;
        }
      }
    }
    catch (error) {
      ElMessage.error(error instanceof Error ? error.message : translate("文本保存失败"));
      throw localRequestId && data.value.pendingLocalTextTask?.id === localRequestId ? pendingMediaTaskError(error, localRequestId) : error;
    }
    finally { textController = undefined; }
  }
  });
  textJob = pending;
  const finish = () => { if (textJob === pending) textJob = undefined; };
  void pending.then(finish, finish);
  return pending;
}
const promptModel = computed({ get: () => data.value.promptModel ?? [], set: (value: PromptModel) => { data.value.promptModel = value; } });

nodeTools.register({
  name: 'getText', description: '分页读取此文本节点的当前真实正文，返回项目正文文件路径和下一段偏移；不调用模型。',
  parameters: z.strictObject({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(16000).default(1000) }),
  async execute({ offset, limit }) {
    await textLoading;
    if (!textReady.value) throw new Error('正文尚未加载');
    const text = outputs.value.text.value;
    return { text: text.slice(offset, offset + limit), path: textPath, totalLength: text.length, hasMore: offset + limit < text.length, nextOffset: offset + limit < text.length ? offset + limit : null };
  },
});
nodeTools.register({
  name: "setText",
  description: "修改此节点的文本输出；可传入 getText 读取的完整 expectedText，正文已被其他编辑修改时拒绝覆盖并保留现有内容。",
  parameters: z.strictObject({ text: z.string(), expectedText: z.string().optional() }),
  async execute({ text, expectedText }) {
    await textLoading;
    if (!textReady.value) throw new Error("文本尚未加载");
    if (generating.value) throw new Error("文本生成中，请稍后修改");
    if (expectedText !== undefined && outputs.value.text.value !== expectedText && outputs.value.text.value !== text) {
      throw Object.assign(new Error(translate("文档内容已变化，请重新读取后编辑")), { response: { status: 409 } });
    }
    if (outputs.value.text.value === text) await saveText(text);
    else { outputs.value.text.value = text; await textSaving; }
    return { text };
  },
});
nodeTools.register({
  name: 'getConfig', description: '读取文本节点当前模型、提示词与真实可选文本模型，不调用模型。', parameters: z.strictObject({}),
  async execute() { await loadModels(); return { config: { providerId: selectedModel.value?.providerId ?? '', modelId: selectedModel.value?.modelId ?? '', prompt: prompt.value }, models: models.value }; },
});
nodeTools.register({
  name: 'setConfig', description: '设置文本节点模型和提示词，模型必须来自 getConfig 的实时目录；不发起生成。',
  parameters: z.strictObject({ providerId: z.string().min(1).optional(), modelId: z.string().min(1).optional(), prompt: z.string().optional() }).refine(args => (args.providerId === undefined) === (args.modelId === undefined), '模型和提供者必须同时提供'),
  async execute(args, { signal }) {
    if (generating.value) throw new Error('文本正在生成');
    await loadModels(); signal?.throwIfAborted();
    if (args.modelId !== undefined && !models.value.some(choice => choice.providerId === args.providerId && choice.modelId === args.modelId)) throw new Error('请选择 getConfig 返回的文本模型');
    if (args.modelId !== undefined) model.value = JSON.stringify([args.providerId, args.modelId]);
    if (args.prompt !== undefined) { prompt.value = args.prompt; promptModel.value = args.prompt.split('\n').map(text => [{ type: 'Write', text }]); }
    return { providerId: selectedModel.value?.providerId, modelId: selectedModel.value?.modelId, prompt: prompt.value };
  },
});
nodeTools.register({
  name: 'generateText', description: '按此文本节点已保存模型、提示词与参考开始后台文本生成，会调用文本模型；用 getGenerationStatus 查看结果，cancelGeneration 请求停止。不调用图片或视频模型。', parameters: z.strictObject({}),
  execute() {
    if (documentError.value) throw new Error(documentError.value);
    if (!textReady.value || generating.value || (!data.value.pendingLocalTextTask && (!selectedModel.value || !prompt.value.trim()))) throw new Error('请先读取配置并设置有效模型与提示词，等待当前生成完成');
    void generateText().catch(() => {});
    return { status: 'running' };
  },
});
nodeTools.register({
  name: 'reloadText', description: '重新读取此文本节点的磁盘正文。expectedText 必须等于刚读到的当前正文，避免覆盖用户新修改；仅在明确需要放弃未保存正文时调用。',
  parameters: z.strictObject({ expectedText: z.string() }),
  async execute({ expectedText }, { signal }) {
    if (generating.value || textReloading.value || outputs.value.text.value !== expectedText) throw new Error('正文已变化或正在处理，请重新读取');
    signal?.throwIfAborted(); await reloadText(true, true, signal); signal?.throwIfAborted();
    if (documentError.value) throw new Error(documentError.value);
    return { text: outputs.value.text.value };
  },
});

nodeTools.register({
  name: 'setTextEditor', description: '打开或关闭此文本节点的正文编辑窗口，可设置 fullscreen；复用界面编辑/全屏按钮，保留正文和保存机制，不调用模型。',
  parameters: z.strictObject({ open: z.boolean(), fullscreen: z.boolean().optional() }),
  async execute(args, { signal }) {
    await textLoading; signal?.throwIfAborted();
    if (!textReady.value) throw new Error('正文尚未加载');
    if (args.fullscreen !== undefined) fullscreen.value = args.fullscreen;
    editing.value = args.open;
    return { open: editing.value, fullscreen: fullscreen.value, readOnly: !!documentError.value || generating.value };
  },
});
nodeTools.register({
  name: 'setTextStyle', description: '设置文本节点背景色，与节点工具栏的背景色选项一致；background 传空字符串表示无背景。只修改显示样式，不改正文。',
  parameters: z.strictObject({ background: z.string().refine(value => TEXT_BACKGROUNDS.includes(value), '请使用文本节点背景色选项中的颜色') }),
  execute({ background }) {
    backgroundColor.value = background;
    return { background: backgroundColor.value };
  },
});
</script>

<style lang="scss" scoped>
.textEditor {
  height: min(560px, calc(100dvh - 144px));
  min-height: 0;

  &.fullscreen {
    height: calc(100dvh - 112px);
  }
}

.textFormatBar {
  :deep(.el-card__body) { display: flex; align-items: center; gap: 2px; }
  .formatButton { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 30px; height: 30px; padding: 0 6px; border: 0; border-radius: 8px; background: transparent; color: var(--el-text-color-primary); font: inherit; font-size: 13px; cursor: pointer;
    &:hover { background: var(--el-fill-color-light); }
  }
  .colorDot { width: 18px; height: 18px; border-radius: 50%; }
  .formatDivider { width: 1px; height: 18px; margin: 0 4px; background: var(--el-border-color); }
}
.colorGrid { display: grid; grid-template-columns: repeat(5, 30px); gap: 10px; padding: 4px;
  button { width: 30px; height: 30px; border: 2px solid transparent; border-radius: 50%; cursor: pointer;
    &.none { border-color: var(--el-border-color); background: linear-gradient(135deg, transparent 46%, var(--el-color-danger) 46% 54%, transparent 54%) !important; }
    &.active { outline: 2px solid var(--el-text-color-primary); outline-offset: 2px; }
  }
}
.blockOption { display: inline-flex; align-items: center; gap: 10px; min-width: 120px;
  .blockMark { width: 22px; color: var(--el-text-color-secondary); font-size: 12px; font-weight: 600; }
  svg { margin-left: auto; }
}

.textContent {
  min-height: 110px;

  &.tinted {
    margin: -8px;
    padding: 8px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--textNodeTint) 16%, transparent);
  }

  .inlineEditor { min-height: 110px; }

  &.empty {
    display: flex;
    align-items: center;
    justify-content: center;

    .editButton {
      margin: 0;
    }
  }

  .textPreview {
    min-height: 110px;
    max-height: 240px;
    overflow: auto;
    overflow-wrap: anywhere;
    user-select: none;
  }

  .editButton {
    display: flex;
    margin-left: auto;
  }
}

.promptCard {
  .promptHeader {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      &:deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .promptActions {
      display: flex;
      align-items: center;
      gap: 12px;

      .toolButton {
        width: 28px;
        height: 28px;
        padding: 0;
      }

      .generationCount {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }

      .sendButton {
        width: 32px;
        height: 32px;
        margin: 0;
        padding: 0;
        --el-button-bg-color: var(--el-text-color-primary);
        --el-button-border-color: transparent;
        --el-button-text-color: var(--el-bg-color);
        --el-button-hover-bg-color: var(--el-text-color-regular);
        --el-button-hover-border-color: transparent;
        --el-button-hover-text-color: var(--el-bg-color);
      }
    }
  }
}
</style>
