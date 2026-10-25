<template>
  <el-dialog v-model="visible" :title="translate('快速打开')" width="min(620px, 94vw)" top="12vh" :closeOnClickModal="false" @opened="input?.focus()">
    <div class="quickOpen" @keydown.down.prevent="step(1)" @keydown.up.prevent="step(-1)" @keydown.enter.prevent="choose(selected)">
      <el-input ref="input" v-model="query" :placeholder="translate('输入文件路径或节点名称')" :aria-label="translate('快速打开文件')" clearable />
      <p class="status" role="status">{{ status }}</p>
      <feedbackNotice :message="visible ? error : ''" @close="error = ''" />
      <div class="resultList" role="listbox" :aria-label="translate('快速打开结果')">
        <button v-for="(item, index) in shown" :key="item.key" class="resultItem" :class="{ selected: selected === index }" role="option" :aria-selected="selected === index" @click="choose(index)">
          <icon-file-text v-if="'filePath' in item.selection" :size="14" aria-hidden="true" />
          <icon-box v-else :size="14" aria-hidden="true" />
          <span class="label">{{ item.selection.label }}</span>
          <small>{{ item.path }}</small>
        </button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import feedbackNotice from "../../../components/feedbackNotice.vue";
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from "vue";
import type { InputInstance } from "element-plus";
import { IconBox, IconFileText } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { useWorkspaceContentFiles as useWorkspaceFiles } from "@/lib/workspaceFiles";
import { listDocumentEntries } from "@/pages/workspace/canvasFiles";
import { candidateExtensions } from "../../../ext";
import { documentError, type DocumentSelection } from "../documentSession";

type Entry = { key: string; path: string; selection: DocumentSelection };
const props = defineProps<{ directory?: string }>();
const emit = defineEmits<{ open: [selection: DocumentSelection] }>();
const visible = ref(false);
const loading = ref(false);
const query = ref("");
const selected = ref(0);
const error = ref("");
const input = ref<InputInstance>();
const entries = shallowRef<Entry[]>([]);
let opened = 0;
let active = true;
let reading: AbortController | undefined;
const results = computed(() => {
  const words = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.value.filter((item) => words.every((word) => `${item.selection.label} ${item.path}`.toLocaleLowerCase().includes(word)))
    .sort((left, right) => Number(right.selection.label.toLocaleLowerCase().startsWith(query.value.toLocaleLowerCase())) - Number(left.selection.label.toLocaleLowerCase().startsWith(query.value.toLocaleLowerCase()))
      || left.path.localeCompare(right.path, "zh-CN", { numeric: true }));
});
const shown = computed(() => results.value.slice(0, 100));
const status = computed(() => loading.value
  ? translate("正在读取工作区…")
  : translate("已找到 {0} 个文件与节点", { 0: entries.value.length }) + (results.value.length > shown.value.length ? translate("，仅展示前 100 个匹配，请缩小范围") : ""));
watch(query, () => { selected.value = 0; });

function cancel() {
  opened++;
  reading?.abort();
  reading = undefined;
  loading.value = false;
}

async function open() {
  const directory = props.directory;
  if (!directory || !active) return;
  cancel();
  const request = opened;
  const controller = new AbortController();
  reading = controller;
  const isCurrent = () => reading === controller && request === opened && directory === props.directory
    && active && visible.value && !controller.signal.aborted;
  visible.value = true;
  loading.value = true;
  query.value = "";
  error.value = "";
  selected.value = 0;
  entries.value = [];
  try {
    const found = await listDocumentEntries(useWorkspaceFiles(directory), {
      limit: 10000,
      signal: controller.signal,
      onError: (path, cause) => { if (isCurrent()) error.value = translate("跳过无法读取的“{0}”：{1}", { 0: path || translate("工作区"), 1: documentError(cause) }); },
    });
    if (!isCurrent()) return;
    entries.value = found.filter((entry) => entry.kind === "node"
      || candidateExtensions({ kind: "file", directory, path: entry.path, label: entry.label }).length)
      .map((entry) => entry.kind === "node"
        ? { key: JSON.stringify([entry.path, entry.nodeId]), path: entry.path, selection: { canvasPath: entry.path, nodeId: entry.nodeId, label: entry.label } }
        : { key: entry.path, path: entry.path, selection: { filePath: entry.path, label: entry.label } });
  } catch (cause) {
    if (isCurrent()) error.value = documentError(cause);
  } finally {
    if (isCurrent()) { loading.value = false; reading = undefined; }
  }
}

async function step(direction: number) {
  if (!visible.value || !active) return;
  const request = opened;
  const count = shown.value.length;
  if (!count) return;
  selected.value = (selected.value + direction + count) % count;
  await nextTick();
  if (request !== opened || !visible.value || !active) return;
  document.querySelector(".quickOpen .resultItem.selected")?.scrollIntoView({ block: "nearest" });
}

function choose(index: number) {
  if (!visible.value || !active) return;
  const entry = shown.value[index];
  if (!entry) return;
  cancel();
  visible.value = false;
  emit("open", entry.selection);
}

watch(visible, shown => { if (!shown) cancel(); }, { flush: "sync" });
watch(() => props.directory, () => { cancel(); visible.value = false; }, { flush: "sync" });
onActivated(() => { active = true; });
onDeactivated(() => { active = false; cancel(); visible.value = false; });
onBeforeUnmount(cancel);
defineExpose({ open });
</script>

<style scoped lang="scss">
.quickOpen {
  .status {
    margin: 10px 0 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
  .resultList {
    max-height: 50vh;
    margin-top: 8px;
    overflow: auto;

    .resultItem {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 9px;
      border: 0;
      color: var(--el-text-color-primary);
      background: transparent;
      text-align: left;
      cursor: pointer;

      &.selected,
      &:hover {
        background: var(--el-fill-color);
      }
      svg {
        flex-shrink: 0;
        color: var(--el-text-color-secondary);
      }
      .label {
        flex-shrink: 0;
        max-width: 50%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      small {
        min-width: 0;
        overflow: hidden;
        color: var(--el-text-color-secondary);
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }
}
</style>
