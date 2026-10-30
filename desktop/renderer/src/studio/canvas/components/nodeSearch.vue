<template>
  <el-dialog v-model="visible" :title="translate('画布节点搜索')" width="min(480px, calc(100vw - 32px))" alignCenter appendToBody @opened="searchInput?.focus()" @close-auto-focus="focusSelectedNode">
    <div class="nodeSearch">
      <div class="searchControls">
      <el-input
        ref="searchInput"
        v-model="query"
        :prefixIcon="IconSearch"
        :placeholder="translate('搜索节点名称或类型')"
        :aria-label="translate('搜索画布节点')"
        aria-controls="canvasSearchResults"
        :aria-activedescendant="results[activeIndex] ? `canvasSearchResult-${activeIndex}` : undefined"
        clearable
        @keydown="navigateResults" />
      <el-select v-model="selectedType" class="typeFilter" :aria-label="translate('节点类型')" :teleported="false">
        <el-option value="all" :label="translate('全部类型')" />
        <el-option v-for="item in typeOptions" :key="item.type" :value="item.type" :label="`${item.label} · ${item.count}`" />
      </el-select>
      </div>
      <p class="resultCount" role="status">{{ translate('找到 {0} 个节点', { 0: results.length }) }}</p>
      <div id="canvasSearchResults" ref="resultList" class="resultList" role="listbox" :aria-label="translate('画布节点')">
        <button
          v-for="(item, index) in results"
          :id="`canvasSearchResult-${index}`"
          :key="item.node.id"
          class="nodeResult"
          type="button"
          role="option"
          tabindex="-1"
          :aria-selected="activeIndex === index"
          @pointermove="activeIndex = index"
          @click="selectNode(index)">
          <component :is="typeIcon(item.type)" :size="18" class="typeIcon" aria-hidden="true" />
          <span class="nodeLabel">{{ item.label }}</span>
          <span class="nodeType">{{ item.typeLabel }}</span>
        </button>
        <p v-if="!results.length" class="empty">{{ translate('没有匹配的节点') }}</p>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { IconSearch, IconFileText, IconPhoto, IconPhotoSpark, IconVideo, IconCameraAi, IconMusic, IconCube3dSphere, IconBoxMultiple, IconPuzzle } from "@tabler/icons-vue";
import type { InputInstance } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import { assertWorkspaceScope, captureWorkspaceScope } from "@/lib/workspaceRemote";

const props = defineProps<{ disabled?: boolean; types?: { type: string; label: string }[] }>();
const flow = useVueFlow();
const visible = ref(false);
const query = ref("");
const selectedType = ref("all");
const activeIndex = ref(0);
const searchInput = ref<InputInstance>();
const resultList = ref<HTMLElement>();
let pendingFocus: { node: GraphNode; scope: ReturnType<typeof captureWorkspaceScope>; element: HTMLElement | null | undefined } | undefined;
onScopeDispose(() => { pendingFocus = undefined; });
function nodeDisplayLabel(node: { id: string; type?: string; data?: { label?: unknown } }) {
  const label = node.data?.label;
  return typeof label === "string" && label.trim() && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(label) ? label : `${translate("未命名节点")} · ${node.id.slice(0, 8)}`;
}
const typeLabels = computed(() => new Map([...(props.types || []).map(item => [item.type, translate(item.label)] as const), ['canvasGroup', translate('分组')]]));
const all = computed(() => flow.getNodes.value.filter(node => !node.hidden).map(node => ({
  node, label: nodeDisplayLabel(node), type: typeLabels.value.has(node.type || '') ? node.type! : 'other',
  typeLabel: typeLabels.value.get(node.type || '') || translate('其他节点'),
})));
const typeOptions = computed(() => {
  const options = new Map<string, { type: string; label: string; count: number }>();
  for (const item of all.value) {
    const option = options.get(item.type);
    if (option) option.count++;
    else options.set(item.type, { type: item.type, label: item.typeLabel, count: 1 });
  }
  return [...options.values()];
});
const results = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  return all.value.filter(item => (selectedType.value === 'all' || item.type === selectedType.value)
    && `${item.label} ${item.typeLabel} ${item.node.type} ${item.node.id}`.toLocaleLowerCase().includes(keyword));
});
function typeIcon(type: string) {
  return ({ 'remote-textNode': IconFileText, 'remote-imageNode': IconPhoto, 'remote-imageGenerationNode': IconPhotoSpark,
    'remote-videoNode': IconVideo, 'remote-videoGenerationNode': IconCameraAi, 'remote-audioNode': IconMusic,
    'remote-director3dNode': IconCube3dSphere, canvasGroup: IconBoxMultiple } as Record<string, typeof IconPhoto>)[type] || IconPuzzle;
}
watch([query, selectedType], () => { activeIndex.value = 0; }, { flush: 'sync' });
watch(results, items => { activeIndex.value = Math.max(0, Math.min(activeIndex.value, items.length - 1)); }, { flush: 'sync' });
watch(typeOptions, items => { if (selectedType.value !== 'all' && !items.some(item => item.type === selectedType.value)) selectedType.value = 'all'; });
watch(activeIndex, async index => {
  await nextTick();
  resultList.value?.children[index]?.scrollIntoView({ block: "nearest" });
});
watch(() => props.disabled, disabled => { if (disabled) { pendingFocus = undefined; visible.value = false; } }, { flush: 'sync' });

function open() {
  if (props.disabled) return;
  pendingFocus = undefined;
  query.value = "";
  selectedType.value = "all";
  activeIndex.value = 0;
  visible.value = true;
}

function navigateResults(event: Event | KeyboardEvent) {
  if (!(event instanceof KeyboardEvent) || event.isComposing || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "ArrowDown") activeIndex.value = Math.max(0, Math.min(activeIndex.value + 1, results.value.length - 1));
  else if (event.key === "ArrowUp") activeIndex.value = Math.max(activeIndex.value - 1, 0);
  else void selectNode(activeIndex.value);
}

async function selectNode(index: number) {
  const node = results.value[index]?.node;
  if (!node || props.disabled) return;
  pendingFocus = { node, scope: captureWorkspaceScope(), element: flow.vueFlowRef.value };
  visible.value = false;
  flow.removeSelectedElements();
  flow.addSelectedNodes([node]);
  flow.nodesSelectionActive.value = false;
  await nextTick();
  // 选中后节点下方会展开编辑卡片，最大只放到 100%，避免卡片被底部工具栏挡住。
  await flow.fitView({ nodes: [node.id], padding: 0.4, maxZoom: 1, duration: 200 });
}

async function focusSelectedNode() {
  const pending = pendingFocus;
  if (!pending) return; // Cancel/Esc keeps the dialog's normal trigger restoration.
  // Element Plus emits close-auto-focus before restoring its trigger. Wait
  // until that synchronous focus-trap cleanup has finished, then hand back to canvas.
  await nextTick();
  if (pendingFocus !== pending) return;
  pendingFocus = undefined;
  if (visible.value || props.disabled || !pending.element?.isConnected
    || flow.vueFlowRef.value !== pending.element || flow.findNode(pending.node.id) !== pending.node
    || pending.node.hidden || !flow.getSelectedNodes.value.includes(pending.node)) return;
  try { assertWorkspaceScope(pending.scope); } catch { return; }
  const label = pending.element.querySelector<HTMLElement>(`.vue-flow__node[data-id="${CSS.escape(pending.node.id)}"] .labelText, .vue-flow__node[data-id="${CSS.escape(pending.node.id)}"] .groupLabel`);
  const target = label ?? pending.element;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

defineExpose({ open });
</script>

<style lang="scss" scoped>
.nodeSearch {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .searchControls { display: flex; gap: 8px; min-width: 0; }
  .typeFilter { width: 132px; flex: none; }
  .resultCount { margin: 0; font-size: 12px; color: var(--el-text-color-secondary); }

  .resultList {
    max-height: min(360px, 50vh);
    overflow-y: auto;

    .nodeResult {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      width: 100%;
      padding: 10px 12px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-primary);
      font: inherit;
      text-align: left;
      cursor: pointer;

      &[aria-selected="true"] { background: var(--el-color-primary-light-9); }
      .typeIcon { flex: none; color: var(--el-text-color-secondary); }
      .nodeLabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .nodeType { flex-shrink: 0; color: var(--el-text-color-secondary); font-size: 12px; }
    }
    .empty { margin: 24px 0; color: var(--el-text-color-secondary); text-align: center; }
  }
}
@media (max-width: 480px) { .nodeSearch .searchControls { flex-wrap: wrap; } .nodeSearch .typeFilter { width: 100%; } }
</style>
