<template>
  <section v-if="traces.length" class="directorTrace">
    <button type="button" class="processToggle" :aria-expanded="open" @click="expanded = !open"><icon-chevron-right :size="13" :class="{ expanded: open }" /><span>{{ translate('处理过程 · {0} 步', { 0: traces.length }) }}</span></button>
    <div v-if="open" ref="list" class="traceList" @scroll="pinned = !$event.target || ($event.target as HTMLElement).scrollHeight - ($event.target as HTMLElement).scrollTop - ($event.target as HTMLElement).clientHeight < 32">
      <small v-if="traces.length > 60">{{ translate('显示最近 {0} 步', { 0: 60 }) }}</small>
      <toolMessage v-for="trace in traces.slice(-60)" :key="trace.id" :tool="{ id: trace.id, name: trace.name, status: trace.status, outcomeUnknown: trace.outcomeUnknown }" :presentation="{ label: translate(trace.label), target: trace.target ?? '', details: trace.details.map(directorTraceText), outcome: directorTraceText(trace.outcome ?? ''), durationMs: trace.durationMs }" @copy="copy" />
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { IconChevronRight } from '@tabler/icons-vue';
import { translate } from '@miaoimg/i18n/vue';
import toolMessage from '../../components/agent/toolMessage.vue';
import type { DirectorToolTrace } from './sceneAnimation';
import { directorTraceText } from './directorTrace';
const props = defineProps<{ traces: DirectorToolTrace[]; running: boolean }>();
const expanded = ref<boolean>(), list = ref<HTMLElement>(), pinned = ref(true);
const open = computed(() => expanded.value ?? props.running);
watch(() => props.running, (running, previous) => { if (!running && previous) expanded.value = undefined; });
watch(() => [props.traces.length, props.traces.at(-1)?.status], async () => { if (pinned.value && open.value && props.running) { await nextTick(); if (list.value) list.value.scrollTop = list.value.scrollHeight; } });
async function copy(text: string) { try { if (window.miaoDesktop?.writeClipboardText) await window.miaoDesktop.writeClipboardText(text); else await navigator.clipboard.writeText(text); ElMessage.success(translate('已复制')); } catch { ElMessage.error(translate('复制失败')); } }
</script>
<style scoped>
.directorTrace{flex-basis:100%;min-width:0;margin-top:6px}.processToggle{display:flex;align-items:center;gap:5px;padding:3px 0;background:transparent;border:0;color:var(--el-text-color-secondary);font:inherit;font-size:11px;cursor:pointer}.processToggle svg{transition:transform .15s}.processToggle svg.expanded{transform:rotate(90deg)}.traceList{display:flex;flex-direction:column;gap:5px;max-height:260px;overflow-y:auto;margin-top:5px;padding-bottom:2px;min-width:0}.traceList>small{font-size:10px;color:var(--el-text-color-secondary)}.traceList :deep(.toolToggle){padding:7px 8px}.traceList :deep(.toolName){font-size:11px}.traceList :deep(.toolState){font-size:10px}
</style>
