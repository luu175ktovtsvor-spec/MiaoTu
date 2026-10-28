<template>
  <section class="referenceMenu" :aria-label="translate('素材引用')" @pointerdown.stop @mousedown.stop @keydown.stop="handleKey">
    <div class="referenceSearch">
      <icon-search :size="15" aria-hidden="true" />
      <input ref="searchInput" v-model="query" type="search" :placeholder="translate('搜索素材')" :aria-label="translate('搜索引用素材')" autocomplete="off" />
      <button v-if="query" type="button" class="clearSearch" :aria-label="translate('清空搜索')" @click="query = ''; searchInput?.focus()"><icon-x :size="13" /></button>
    </div>
    <button v-if="scope && !query" type="button" class="scopeBack" @mousedown.prevent @click="scope = undefined">
      <icon-chevron-left :size="14" /><span>{{ kindLabel(scope) }}</span>
    </button>
    <div ref="list" class="referenceMenuList" role="listbox" :aria-label="translate('素材引用')">
      <template v-if="!scope && !query.trim()">
        <p v-if="connected.length" class="sectionTitle">{{ translate('已引用') }}</p>
        <button v-for="(item, index) in connected" :key="item.id" type="button" class="referenceChoice" role="option" :aria-selected="active === index" :class="{ active: active === index }" :data-reference-menu-index="index" @mousedown.prevent @pointermove="active = index" @focus="active = index" @click="emit('select', item)">
          <referenceMenuPreview :item="item" /><span class="choiceName">{{ item.label || item.name }}</span>
        </button>
        <p class="sectionTitle">{{ translate('素材引用') }}</p>
        <button v-for="(kind, index) in kinds" :key="kind" type="button" class="referenceChoice" role="option" :aria-selected="active === connected.length + index" :class="{ active: active === connected.length + index }" :data-reference-menu-index="connected.length + index" @mousedown.prevent @pointermove="active = connected.length + index" @focus="active = connected.length + index" @click="scope = kind">
          <component :is="kindIcon(kind)" :size="17" aria-hidden="true" /><span class="choiceName">{{ kindLabel(kind) }}</span><icon-chevron-right :size="13" class="choiceArrow" />
        </button>
        <button v-if="assetsAvailable" type="button" class="referenceChoice" role="option" :aria-selected="active === connected.length + kinds.length" :class="{ active: active === connected.length + kinds.length }" :data-reference-menu-index="connected.length + kinds.length" @mousedown.prevent @pointermove="active = connected.length + kinds.length" @focus="active = connected.length + kinds.length" @click="emit('assets')">
          <icon-folder :size="17" aria-hidden="true" /><span class="choiceName">{{ translate('素材库') }}</span><icon-chevron-right :size="13" class="choiceArrow" />
        </button>
        <p v-if="!count" class="emptyReferences">{{ translate('画布中暂无可引用素材') }}</p>
      </template>
      <template v-else>
        <p class="sectionTitle">{{ query.trim() ? translate('搜索结果') : translate('画布素材') }}</p>
        <button v-for="(item, index) in visibleItems" :key="item.id" type="button" class="referenceChoice" role="option" :aria-selected="active === index" :class="{ active: active === index }" :data-reference-menu-index="index" @mousedown.prevent @pointermove="active = index" @focus="active = index" @click="emit('select', item)">
          <referenceMenuPreview :item="item" /><span class="choiceName">{{ item.label || item.name }}</span><span v-if="connectedIds.has(item.id)" class="connectedBadge">{{ translate('已引用') }}</span>
        </button>
        <p v-if="!filtered.length" class="emptyReferences">{{ translate(query.trim() ? '未找到匹配素材' : '画布中暂无可引用素材') }}</p>
        <p v-else-if="filtered.length > visibleItems.length" class="emptyReferences">{{ translate('还有 {0} 个素材，请输入名称搜索', { 0: filtered.length - visibleItems.length }) }}</p>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { IconChevronLeft, IconChevronRight, IconFileText, IconFolder, IconMusic, IconPhoto, IconSearch, IconVideo, IconX } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { REFERENCE_KINDS, REFERENCE_KIND_LABELS, type ReferenceKind, type ReferenceMenuItem } from "../referenceMenu";
import referenceMenuPreview from "./referenceMenuPreview.vue";

const props = defineProps<{ connected: ReferenceMenuItem[]; candidates: ReferenceMenuItem[]; availableKinds?: ReferenceKind[]; open: boolean; assetsAvailable?: boolean }>();
const query = defineModel<string>("query", { default: "" });
const emit = defineEmits<{ select: [item: ReferenceMenuItem]; close: []; assets: [] }>();
const searchInput = ref<HTMLInputElement>(), list = ref<HTMLElement>();
const scope = ref<ReferenceKind>(), active = ref(0);
const kinds = computed(() => props.availableKinds || REFERENCE_KINDS.filter(kind => [...props.connected, ...props.candidates].some(item => item.kind === kind)));
const connectedIds = computed(() => new Set(props.connected.map(item => item.id)));
const all = computed(() => [...new Map([...props.connected, ...props.candidates].map(item => [item.id, item])).values()]);
const kindLabel = (kind: ReferenceKind) => translate(REFERENCE_KIND_LABELS[kind]);
const kindIcon = (kind: ReferenceKind) => ({ IMAGE: IconPhoto, VIDEO: IconVideo, AUDIO: IconMusic, STRING: IconFileText })[kind];
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return all.value.filter(item => (!scope.value || item.kind === scope.value) && (!needle || `${item.label || ''} ${item.name} ${item.kind ? kindLabel(item.kind) : ''}`.toLocaleLowerCase().includes(needle)));
});
const root = computed(() => !scope.value && !query.value.trim());
const visibleItems = computed(() => filtered.value.slice(0, 80));
const count = computed(() => root.value ? props.connected.length + kinds.value.length + Number(Boolean(props.assetsAvailable)) : visibleItems.value.length);
watch([scope, query, () => props.open], () => { active.value = 0; if (!props.open) scope.value = undefined; }, { flush: 'sync' });
watch(count, value => { active.value = Math.max(0, Math.min(active.value, value - 1)); }, { flush: 'sync' });

function chooseActive() {
  if (!root.value) { const item = visibleItems.value[active.value]; if (item) emit('select', item); return; }
  const connected = props.connected[active.value];
  if (connected) { emit('select', connected); return; }
  const kind = kinds.value[active.value - props.connected.length];
  if (kind) scope.value = kind;
  else if (props.assetsAvailable) emit('assets');
}
function handleKey(event: KeyboardEvent) {
  if (event.isComposing || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(event.key)) return false;
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target === searchInput.value) return false;
  if (event.key === 'Enter' && event.target instanceof Element && event.target.closest('.scopeBack, .clearSearch')) return false;
  if ((event.key === 'ArrowLeft' && !scope.value) || (event.key === 'ArrowRight' && (!root.value || active.value < props.connected.length || active.value >= props.connected.length + kinds.value.length))) { emit('close'); return false; }
  event.preventDefault(); event.stopPropagation();
  if (event.key === 'Escape') { if (scope.value) scope.value = undefined; else emit('close'); }
  else if (event.key === 'ArrowLeft') scope.value = undefined;
  else if (event.key === 'Enter' || event.key === 'ArrowRight') chooseActive();
  else if (count.value) {
    active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + count.value) % count.value;
    void nextTick(() => list.value?.querySelector<HTMLElement>(`[data-reference-menu-index="${active.value}"]`)?.scrollIntoView({ block: 'nearest' }));
  }
  return true;
}
defineExpose({ handleKey });
</script>

<style scoped>
.referenceMenu { display: flex; flex-direction: column; height: min(330px, calc(100dvh - 36px)); width: 236px; max-width: calc(100vw - 36px); color: var(--el-text-color-primary); font: 13px/1.5 "PingFang SC",Inter,sans-serif; }
.referenceSearch { flex: none; display: flex; align-items: center; gap: 5px; height: 32px; margin: 0 0 5px; padding: 0 8px; border: 1px solid var(--canvas-hover-line, var(--el-border-color)); border-radius: 8px; color: var(--el-text-color-secondary); }
.referenceSearch:focus-within { border-color: var(--el-text-color-secondary); }
.referenceSearch input { width: 100%; min-width: 0; padding: 0; outline: none !important; border: 0; background: transparent; color: var(--el-text-color-primary); font: inherit; }
.referenceSearch input::-webkit-search-cancel-button { display: none; }
.referenceSearch input::placeholder { color: var(--el-text-color-secondary); }
.clearSearch { display: grid; place-items: center; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; }
.referenceMenuList { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.sectionTitle { margin: 5px 8px 3px; color: var(--el-text-color-secondary); font-size: 11px; }
.referenceChoice, .scopeBack { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 36px; padding: 6px 8px; border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.referenceChoice.active, .referenceChoice:hover, .scopeBack:hover { background: var(--el-fill-color); }
.choiceName { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.choiceArrow, .connectedBadge { flex: none; color: var(--el-text-color-secondary); }
.connectedBadge { font-size: 10px; }
.scopeBack { flex: none; min-height: 28px; color: var(--el-text-color-secondary); }
.emptyReferences { margin: 12px 8px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
</style>
