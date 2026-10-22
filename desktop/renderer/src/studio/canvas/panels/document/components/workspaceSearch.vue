<template>
  <el-dialog
    v-model="visible"
    :title="translate('工作区全文搜索')"
    width="min(900px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    :closeOnClickModal="false"
    :closeOnPressEscape="!replacing"
    :showClose="!replacing"
    @closed="onClosed">
    <div class="workspaceSearch">
      <form class="searchControls" @submit.prevent="search">
        <el-input ref="queryInput" v-model="query" :placeholder="translate('查找文本（字面匹配）')" :aria-label="translate('查找文本')" :disabled="replacing" clearable />
        <el-checkbox v-model="caseSensitive" :disabled="replacing">{{ translate("区分大小写") }}</el-checkbox>
        <el-button type="primary" nativeType="submit" :disabled="!query || !active || searching || replacing">{{ translate("搜索") }}</el-button>
        <el-button v-if="searching" @click="cancelSearch">{{ translate("取消") }}</el-button>
      </form>
      <div class="replaceControls">
        <el-input v-model="replacement" :placeholder="translate('替换为（留空表示删除）')" :aria-label="translate('替换文本')" :disabled="replacing" />
        <el-button :disabled="searching || replacing || !selectedFiles.length || !active" @click="previewing = true">{{ translate("预览替换") }}</el-button>
      </div>
      <p class="searchScope">{{ translate("搜索磁盘内容，只搜索文档编辑器能打开的文本文件。单文件最多 2 MiB，本次最多检查 1000 个文件、20 MiB 文本，展示 500 处匹配。") }}</p>
      <p class="searchStatus" role="status" aria-live="polite">{{ status ? translate(status) : translate("输入文本后搜索当前工作区及其子目录。") }}</p>
      <p v-if="searched" class="searchCounts">{{ translate("已读取 {0} 个文本文件，{1} 个文件命中 {2} 处。", { 0: scanned, 1: results.length, 2: matchCount }) }}</p>
      <p v-if="searched && (skippedLarge || readFailures)" class="searchCounts">{{ translate("跳过：过大文件 {0}，读取失败 {1}。", { 0: skippedLarge, 1: readFailures }) }}</p>
      <el-alert v-if="issues.length" type="warning" :closable="false" :title="issues.join('；')" />
      <template v-if="previewing">
        <div class="previewHeader">
          <strong>{{ translate("替换预览：{0} 个文件，{1} 处", { 0: selectedFiles.length, 1: selectedMatchCount }) }}</strong>
          <el-button size="small" :disabled="replacing" @click="previewing = false">{{ translate("返回结果") }}</el-button>
        </div>
        <p class="replaceNotice">{{ translate("仅替换勾选文件中已完整搜索的匹配。逐文件保存；冲突文件会保留原文，已完成的文件不会因其他文件失败而回滚。") }}</p>
      </template>
      <div class="searchResults" :aria-busy="searching || replacing">
        <section v-for="file in shownFiles" :key="file.path" class="fileResult">
          <header class="fileHeader">
            <el-checkbox
              v-if="!previewing"
              :modelValue="file.selected"
              :disabled="file.truncated || replacing || !!file.saved"
              :aria-label="translate('选择替换 {0}', { 0: file.path })"
              @change="value => selectFile(file.path, value === true)" />
            <span class="filePath" :title="file.path">{{ file.path }}</span>
            <span>{{ translate("{0} 处", { 0: file.matches.length }) }}</span>
            <span v-if="file.saved" class="savedStatus">{{ translate("已替换") }}</span>
          </header>
          <p v-if="file.truncated" class="fileNotice">{{ translate("此文件的匹配超过本次展示限制，暂不参与替换。") }}</p>
          <p v-if="file.error" class="fileError" role="alert">{{ file.error }}</p>
          <div v-for="match in file.matches" :key="match.start" class="matchResult">
            <button v-if="!previewing" type="button" class="matchButton" :disabled="replacing || !!file.saved" @click="openMatch(file.path, match)">
              <span class="matchPosition">{{ match.line }}:{{ match.column }}</span>
              <span class="matchSnippet">{{ match.before }}<mark>{{ match.text }}</mark>{{ match.after }}</span>
            </button>
            <div v-else class="matchPreview">
              <span class="matchPosition">{{ match.line }}:{{ match.column }}</span>
              <div class="previewLines">
                <div class="beforeLine"><span :aria-label="translate('原内容')">− </span>{{ match.before }}<mark>{{ match.text }}</mark>{{ match.after }}</div>
                <div class="afterLine"><span :aria-label="translate('替换后')">+ </span>{{ match.before }}<mark>{{ replacement }}</mark>{{ match.after }}</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
    <template #footer>
      <el-button v-if="replacing" :disabled="replaceCancelled" @click="replaceCancelled = true">{{ translate("停止后续替换") }}</el-button>
      <el-button v-else @click="visible = false">{{ translate("关闭") }}</el-button>
      <el-button v-if="previewing" type="primary" :loading="replacing" :disabled="!selectedFiles.length || !active || replacing" @click="replaceSelected">{{ translate("确认替换勾选文件") }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { ElAlert, ElButton, ElCheckbox, ElDialog, ElInput, type InputInstance } from "element-plus";
import { msg, translate, type MessageDescriptor } from "@miaoimg/i18n/vue";
import { useWorkspaceContentFiles as useWorkspaceFiles } from "@/lib/workspaceFiles";
import { textExtensions } from "../../../ext";
import { documentError } from "../documentSession";

type SearchMatch = { start: number; end: number; line: number; column: number; before: string; text: string; after: string };
type SearchFile = { path: string; text: string; matches: SearchMatch[]; truncated: boolean; selected: boolean; saved?: boolean; error?: string };
export type WorkspaceSearchTarget = { path: string; query: string; line: number; column: number };
const props = defineProps<{ directory?: string; active: boolean; replaceFile: (path: string, expectedText: string, nextText: string) => Promise<void> }>();
const emit = defineEmits<{ open: [target: WorkspaceSearchTarget] }>();
const visible = ref(false);
let pendingTarget: WorkspaceSearchTarget | undefined;
const queryInput = ref<InputInstance>();
const query = ref("");
const replacement = ref("");
const caseSensitive = ref(false);
const searching = ref(false);
const replacing = ref(false);
const replaceCancelled = ref(false);
const previewing = ref(false);
const searched = ref(false);
const status = shallowRef<MessageDescriptor>();
const scanned = ref(0);
const skippedLarge = ref(0);
const readFailures = ref(0);
const issues = ref<string[]>([]);
const results = shallowRef<SearchFile[]>([]);
const selectedFiles = computed(() => results.value.filter((file) => file.selected && !file.truncated && !file.saved));
const selectedMatchCount = computed(() => selectedFiles.value.reduce((total, file) => total + file.matches.length, 0));
const shownFiles = computed(() => previewing.value ? selectedFiles.value : results.value);
const matchCount = computed(() => results.value.reduce((total, file) => total + file.matches.length, 0));
let searchController: AbortController | undefined;
let searchRevision = 0;
let searchedQuery = "";

async function open() {
  if (!props.active || !props.directory) return;
  const directory = props.directory;
  pendingTarget = undefined;
  visible.value = true;
  await nextTick();
  if (!visible.value || !props.active || props.directory !== directory) return;
  queryInput.value?.focus();
}

function cancelSearch() {
  const wasSearching = searching.value;
  searchController?.abort();
  searchController = undefined;
  searchRevision++;
  searching.value = false;
  if (wasSearching) status.value = msg`搜索已取消；以下为已找到的部分结果。`;
}

function findMatches(text: string, needle: string, matchCase: boolean, limit: number) {
  const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "gu" : "giu");
  const matches: SearchMatch[] = [];
  let line = 1;
  let lineStart = 0;
  let nextLine = text.indexOf("\n");
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    if (matches.length >= limit) return { matches, truncated: true };
    while (nextLine >= 0 && nextLine < match.index) {
      line++;
      lineStart = nextLine + 1;
      nextLine = text.indexOf("\n", lineStart);
    }
    const end = match.index + match[0].length;
    const lineEnd = text.indexOf("\n", end);
    const beforeStart = Math.max(lineStart, match.index - 60);
    const afterEnd = Math.min(lineEnd < 0 ? text.length : lineEnd, end + 100);
    matches.push({ start: match.index, end, line, column: match.index - lineStart + 1, text: match[0],
      before: `${beforeStart > lineStart ? "…" : ""}${text.slice(beforeStart, match.index)}`,
      after: `${text.slice(end, afterEnd).replace(/\r$/, "")}${afterEnd < (lineEnd < 0 ? text.length : lineEnd) ? "…" : ""}` });
  }
  return { matches, truncated: false };
}

async function search() {
  const directory = props.directory;
  if (!query.value || !directory || !props.active || !visible.value || replacing.value || searching.value) return;
  const files = useWorkspaceFiles(directory);
  const controller = new AbortController();
  searchController = controller;
  const revision = ++searchRevision;
  const ownsRequest = () => searchController === controller && revision === searchRevision;
  const isCurrent = () => ownsRequest() && props.directory === directory && props.active && visible.value && !controller.signal.aborted;
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    if (!isCurrent()) throw new DOMException("Search changed", "AbortError");
  };
  const needle = query.value;
  const matchCase = caseSensitive.value;
  const extensions = textExtensions();
  searchedQuery = needle;
  results.value = [];
  issues.value = [];
  scanned.value = skippedLarge.value = readFailures.value = 0;
  searching.value = searched.value = true;
  previewing.value = false;
  status.value = msg`正在搜索磁盘文件…`;
  let inspected = 0;
  let textLength = 0;
  let limited: MessageDescriptor | undefined;
  const recordFailure = (path: string, error: unknown) => {
    assertCurrent();
    readFailures.value++;
    if (issues.value.length < 5) issues.value.push(`${path || translate("工作区根目录")}：${documentError(error)}`);
  };
  try {
    // 工作区接口一次返回全部文件，这里不再逐层遍历目录。
    const { entries } = await files.list(undefined, controller.signal);
    assertCurrent();
    for (const entry of entries.slice().sort((left, right) => left.path.localeCompare(right.path))) {
      assertCurrent();
      if (entry.type === "directory") continue;
      const suffix = entry.name.split(".").at(-1)?.toLowerCase() ?? "";
      if (!extensions.has(suffix)) continue;
      if (++inspected > 1000) { limited = msg`已达到 1000 个文件的检查上限，已停止。以下为部分结果，可缩小查找文本后重试。`; break; }
      try {
        // ACT: 按 size 预筛，超过 2 MiB 的文本直接跳过；读全文保证替换不会写到被截断的内容上。
        if (Number((entry as { size?: number }).size ?? 0) > 2 * 1024 * 1024) { skippedLarge.value++; continue; }
        const text = await files.readText(entry.path, undefined, controller.signal);
        assertCurrent();
        textLength += text.length;
        if (textLength > 20 * 1024 * 1024) { limited = msg`已达到 20 MiB 文本的搜索上限，已停止。以下为部分结果，可缩小查找文本后重试。`; break; }
        scanned.value++;
        const found = findMatches(text, needle, matchCase, 500 - matchCount.value);
        if (found.matches.length) results.value = [...results.value, { path: entry.path, text, ...found, selected: !found.truncated }];
        if (matchCount.value >= 500) { limited = msg`已达到 500 处匹配的展示上限，已停止。以下为部分结果，可缩小查找文本后重试。`; break; }
      } catch (error) {
        assertCurrent();
        recordFailure(entry.path, error);
      }
    }
    assertCurrent();
    status.value = limited ?? (readFailures.value ? msg`搜索结束，部分文件读取失败；上方显示前 5 项失败原因。` : msg`搜索完成。`);
  } catch (error) {
    if (isCurrent()) status.value = msg`搜索未完成：${documentError(error)}。以下为已找到的部分结果。`;
  } finally {
    if (ownsRequest()) { searching.value = false; searchController = undefined; }
  }
}

function selectFile(path: string, selected: boolean) {
  results.value = results.value.map((file) => file.path === path ? { ...file, selected } : file);
}

function openMatch(path: string, match: SearchMatch) {
  if (!visible.value || !props.active) return;
  cancelSearch();
  pendingTarget = { path, query: match.text, line: match.line, column: match.column };
  visible.value = false;
}

function onClosed() {
  if (visible.value) return;
  cancelSearch();
  // 关闭弹窗的焦点捕获后再定位编辑器，避免新建的原文输入框被弹窗夺回光标。
  if (pendingTarget && props.active) emit("open", pendingTarget);
  pendingTarget = undefined;
}

function replaceMatches(file: SearchFile, value: string) {
  let end = 0;
  let text = "";
  for (const match of file.matches) {
    text += file.text.slice(end, match.start) + value;
    end = match.end;
  }
  return text + file.text.slice(end);
}

async function replaceSelected() {
  const directory = props.directory;
  if (!directory || !props.active || replacing.value || searching.value || !previewing.value || !selectedFiles.value.length) return;
  const files = selectedFiles.value;
  const value = replacement.value;
  replacing.value = true;
  replaceCancelled.value = false;
  let succeeded = 0;
  let failed = 0;
  try {
    for (const file of files) {
      if (replaceCancelled.value || props.directory !== directory || !props.active) break;
      try {
        const text = replaceMatches(file, value);
        if (text !== file.text) await props.replaceFile(file.path, file.text, text);
        succeeded++;
        results.value = results.value.map((item) => item === file ? { ...item, saved: true, selected: false, error: undefined } : item);
      } catch (error) {
        failed++;
        results.value = results.value.map((item) => item === file ? { ...item, error: documentError(error) } : item);
      }
    }
  } finally {
    replacing.value = false;
    previewing.value = false;
    const pending = files.length - succeeded - failed;
    if (props.directory === directory && props.active) status.value = pending
      ? msg`替换已停止：成功 ${succeeded} 个文件，失败 ${failed} 个，未处理 ${pending} 个。请重新搜索以刷新结果。`
      : msg`替换结束：成功 ${succeeded} 个文件，失败 ${failed} 个。请重新搜索以刷新结果。`;
  }
}

watch([query, caseSensitive], () => {
  cancelSearch();
  results.value = [];
  issues.value = [];
  searched.value = false;
  status.value = undefined;
  previewing.value = false;
}, { flush: "sync" });
watch(replacement, () => { previewing.value = false; });
watch(visible, shown => { if (!shown) cancelSearch(); }, { flush: "sync" });
watch(() => [props.directory, props.active], () => {
  pendingTarget = undefined;
  cancelSearch();
  replaceCancelled.value = true;
  visible.value = false;
  results.value = [];
  issues.value = [];
  searched.value = false;
  status.value = undefined;
}, { flush: "sync" });
onBeforeUnmount(() => { cancelSearch(); replaceCancelled.value = true; });
defineExpose({ open });
</script>

<style scoped lang="scss">
.workspaceSearch {
  .searchControls,
  .replaceControls {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;

    .el-input {
      flex: 1;
    }
  }
  .searchScope,
  .searchCounts,
  .replaceNotice {
    margin: 8px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.6;
  }
  .searchStatus {
    margin: 10px 0;
    font-size: 13px;
  }
  .previewHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
  }
  .searchResults {
    max-height: min(52vh, 560px);
    margin-top: 12px;
    border-top: 0;
    overflow: auto;

    .fileResult {
      padding: 10px 0;
      border-bottom: 0;

      .fileHeader {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 8px;
        font-size: 12px;

        .filePath {
          flex: 1;
          min-width: 0;
          font-weight: 600;
          overflow-wrap: anywhere;
        }
        .savedStatus {
          color: var(--el-color-success);
        }
      }
      .fileNotice,
      .fileError {
        margin: 6px 8px;
        color: var(--el-color-warning);
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      .fileError {
        color: var(--el-color-danger);
      }
      .matchResult {
        .matchButton,
        .matchPreview {
          display: flex;
          box-sizing: border-box;
          width: 100%;
          gap: 10px;
          padding: 5px 8px;
          font: 12px/1.7 Consolas, monospace;
          text-align: left;
        }
        .matchButton {
          border: 0;
          color: var(--el-text-color-primary);
          background: transparent;
          cursor: pointer;

          &:hover {
            background: var(--el-fill-color-light);
          }
          &:focus-visible {
            outline: 1px solid var(--el-color-primary);
          }
          &:disabled {
            cursor: default;
            opacity: 0.6;
          }
        }
        .matchPosition {
          flex-shrink: 0;
          min-width: 48px;
          color: var(--el-text-color-secondary);
        }
        .matchSnippet,
        .previewLines {
          min-width: 0;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        mark {
          color: inherit;
          background: var(--el-color-warning-light-5);
        }
        .previewLines {
          flex: 1;

          .beforeLine {
            background: var(--el-color-danger-light-9);
          }
          .afterLine {
            background: var(--el-color-success-light-9);
          }
        }
      }
    }
  }
}
</style>
