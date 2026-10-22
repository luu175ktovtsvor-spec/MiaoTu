<template>
  <teleport v-if="target" :to="target"><el-button :icon="IconHistory" :disabled="disabled" text :title="translate('历史记录')" :aria-label="translate('历史记录')" @click.stop="visible = true" /></teleport>
  <el-dialog v-model="visible" :title="translate('{0}历史记录', { 0: mediaType === 'image' ? translate('图片') : translate('视频') })" width="min(760px, calc(100vw - 32px))" appendToBody destroyOnClose>
    <div v-loading="loading" class="mediaHistory nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
      <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" />
      <el-empty v-else-if="!loading && !items.length" :description="translate('暂无历史记录')" />
      <template v-else-if="items.length">
        <div class="historyContent">
          <div class="historyList" :aria-label="translate('历史文件')">
            <button
              v-for="item in pageItems"
              :key="item.url"
              type="button"
              class="historyItem"
              :class="{ selected: selected?.url === item.url }"
              :aria-pressed="selected?.url === item.url"
              :title="item.url"
              @click="selected = item">
              <span class="fileName">{{ item.url.split('/').at(-1) }}</span>
              <span v-if="item.url === current?.url.replaceAll('\\', '/')" class="currentLabel">{{ translate('当前结果') }}</span>
            </button>
          </div>
          <div class="historyPreview" v-loading="!!selected && !previewReady && !previewError">
            <el-alert v-if="previewError" :title="previewError" type="error" :closable="false" />
            <img v-else-if="previewUrl && mediaType === 'image'" :src="previewUrl" :alt="translate('历史图片预览')" @load="previewReady = true" @error="previewError = translate('无法预览该图片')" />
            <video v-else-if="previewUrl" :src="workspacePlaybackUrl(previewUrl)" controls playsinline preload="auto" :aria-label="translate('历史视频预览')" @loadeddata="previewReady = true" @error="previewError = translate('无法预览该视频')" />
          </div>
        </div>
        <el-pagination v-model:currentPage="page" :pageSize="pageSize" :total="items.length" layout="prev, pager, next" hideOnSinglePage />
      </template>
    </div>
    <template #footer>
      <el-button @click="visible = false">{{ translate('关闭') }}</el-button>
      <el-button type="primary" :disabled="disabled || loading || !selected || !previewUrl || !previewReady || !!previewError" @click="selectOutput">{{ translate('设为当前结果') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { workspacePlaybackUrl } from "@/lib/workspaceFiles";
import { computed, ref, watch } from "vue";
import { useNode } from "@vue-flow/core";
import { ElAlert, ElButton, ElDialog, ElEmpty, ElLoading, ElPagination } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import { IconHistory } from "@tabler/icons-vue";
import { nodeTools, z } from "../nodeTools";
import { useNodeFiles } from "../workspaceFiles";
import type { NodeMediaValue } from "../values";

const props = defineProps<{ mediaType: "image" | "video"; current?: NodeMediaValue; disabled?: boolean; target?: HTMLElement }>();
const emit = defineEmits<{ select: [value: NodeMediaValue] }>();
const vLoading = ElLoading.directive;
const { id } = useNode();
const files = useNodeFiles();
const visible = ref(false);
const loading = ref(false);
const loadError = ref("");
const previewError = ref("");
const previewReady = ref(false);
const items = ref<NodeMediaValue[]>([]);
const selected = ref<NodeMediaValue>();
const page = ref(1);
const pageSize = 20;
const pageItems = computed(() => items.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const mimeTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  avif: "image/avif", apng: "image/apng", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", ogv: "video/ogg",
};
const previewFile = computed(() => visible.value ? selected.value : undefined);
watch(previewFile, () => { previewError.value = ""; }, { flush: "sync" });
// ACT: 目录列表仅保存路径，每页显示 20 条，只读取选中文件；海量目录需服务端分页时再扩展 list。
const previewUrl = files.useFileUrl(previewFile, () => { previewError.value = translate("历史文件读取失败，文件可能已被移动或删除"); });
watch([previewFile, previewUrl], () => { previewReady.value = false; }, { flush: "sync" });

watch(() => props.disabled, disabled => { if (disabled) visible.value = false; });
watch(visible, async (open, _previous, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  items.value = [];
  selected.value = undefined;
  loadError.value = "";
  page.value = 1;
  if (!open) return;
  loading.value = true;
  try {
    const history = await readHistory();
    if (cancelled) return;
    items.value = history;
    const current = props.current;
    selected.value = current ?? items.value[0];
    page.value = Math.floor(Math.max(0, items.value.findIndex(item => item.url === selected.value?.url)) / pageSize) + 1;
  } catch (error) {
    if (!cancelled) {
      const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
      loadError.value = message || (error instanceof Error ? error.message : translate("历史记录读取失败"));
    }
  } finally {
    if (!cancelled) loading.value = false;
  }
});

async function readHistory() {
    const { entries } = await files.getWorkspaceFiles().list(`assets/${id}`).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "ENOENT") throw error;
      return { entries: [] };
    });
    const results = new Map<string, NodeMediaValue>();
    for (const entry of entries) {
      const mimeType = mimeTypes[entry.name.split(".").at(-1)?.toLowerCase() ?? ""];
      if (entry.type === "file" && entry.path.replaceAll("\\", "/").startsWith(`assets/${id}/`) && mimeType?.startsWith(`${props.mediaType}/`)) {
        const url = entry.path.replaceAll("\\", "/");
        results.set(url, { url, mimeType });
      }
    }
    // ACT: 副本使用新 ID，但当前结果仍可能引用原节点文件；只补当前结果，不继承原目录的全部历史。
    const current = props.current && { ...props.current, url: props.current.url.replaceAll("\\", "/") };
    if (current) results.set(current.url, current);
    return [...results.values()].sort((left, right) => left.url.localeCompare(right.url, "zh-CN", { numeric: true }));

}
nodeTools.register({
  name: 'getOutputHistory', description: '分页列举本节点已保存的图片或视频历史结果，返回工作区文件引用，不调用生成模型。',
  parameters: z.strictObject({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }),
  async execute({ offset, limit }) { const history = await readHistory(); return { items: history.slice(offset, offset + limit), total: history.length, hasMore: offset + limit < history.length, nextOffset: offset + limit < history.length ? offset + limit : null }; },
});
nodeTools.register({
  name: props.mediaType === 'image' ? 'setImage' : 'setVideo', description: '将当前项目内已有的同类型媒体设为本节点当前结果，等同替换或恢复历史结果；保留生成参数，不提交生成，不删除已有文件。',
  parameters: z.strictObject({ path: z.string().min(1).max(4096) }),
  async execute({ path }, { signal }) {
    if (props.disabled) throw new Error('节点正在生成或处理');
    const entry = (await files.getWorkspaceFiles().list()).entries.find(entry => entry.path === path && entry.type === 'file');
    signal?.throwIfAborted();
    const mimeType = mimeTypes[path.split('.').at(-1)?.toLowerCase() ?? ''];
    if (!entry || !mimeType?.startsWith(`${props.mediaType}/`)) throw new Error('项目内不存在该类型媒体');
    if (props.disabled) throw new Error('节点正在生成或处理');
    emit('select', {url:path,mimeType});
    return {url:path,mimeType};
  },
});

function selectOutput() {
  if (props.disabled || loading.value || !selected.value || !previewUrl.value || !previewReady.value || previewError.value) return;
  emit("select", { ...selected.value });
  visible.value = false;
}
</script>

<style scoped lang="scss">
.mediaHistory {
  min-height: 300px;

  .historyContent {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) minmax(0, 2fr);
    gap: 16px;

    .historyList {
      height: 360px;
      overflow: auto;

      .historyItem {
        display: block;
        width: 100%;
        padding: 10px;
        border: 1px solid transparent;
        border-radius: var(--el-border-radius-base);
        background: transparent;
        color: var(--el-text-color-primary);
        font: inherit;
        text-align: left;
        cursor: pointer;

        &:hover { background: var(--el-fill-color-light); }
        &.selected { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
        .fileName { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .currentLabel { color: var(--el-color-primary); font-size: 12px; }
      }
    }

    .historyPreview {
      display: grid;
      place-items: center;
      height: 360px;
      min-width: 0;
      background: var(--el-fill-color-light);
      border-radius: var(--el-border-radius-base);

      img, video { width: 100%; max-height: 360px; object-fit: contain; }
    }
  }

  .el-pagination { justify-content: center; margin-top: 16px; }
}
</style>

<style scoped>
@media (max-width: 700px) {
  .mediaHistory .historyContent { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .mediaHistory .historyContent .historyList { height: 112px; }
  .mediaHistory .historyContent .historyPreview { height: min(240px, calc(100dvh - 300px)); }
  .mediaHistory .historyContent .historyPreview img,
  .mediaHistory .historyContent .historyPreview video { max-height: min(240px, calc(100dvh - 300px)); }
}
@media (min-width: 701px) and (max-height: 640px) {
  .mediaHistory .historyContent .historyList,
  .mediaHistory .historyContent .historyPreview { height: max(120px, calc(100dvh - 210px)); }
  .mediaHistory .historyContent .historyPreview img,
  .mediaHistory .historyContent .historyPreview video { max-height: max(120px, calc(100dvh - 210px)); }
}
</style>
