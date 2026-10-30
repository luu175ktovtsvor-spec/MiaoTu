<template>
  <div v-if="controller.active">
    <imageInpaintPrompt ref="prompt" :target="target" :generate="generate" :generating="generating" :pending="pending" :cancel="cancel" :disabled="disabled"
      :mask-only="true" :fixed-size="controller.fixedSize" :initial-config="controller.initialConfig" :model-filter="controller.allows" :send-disabled="!pending && (loading || Boolean(error) || points == null)">
      <template #header><div class="preparedOutpaintHeading"><strong>{{ translate('扩图') }}</strong><el-tooltip placement="top" :content="translate('使用已保存的扩图画布与蒙版，确认模型、指令和预计积分后再生成；模型仍可能改变原图细节，原件会保留。')"><el-button text :icon="IconInfoCircle" :aria-label="translate('操作说明')" /></el-tooltip></div></template>
      <template #estimate><span class="outpaintEstimate" :title="error" aria-live="polite">{{ translate('预计积分') }} {{ loading ? '…' : points == null ? '—' : points.toLocaleString(undefined, { maximumFractionDigits: 4 }) }}</span></template>
    </imageInpaintPrompt>
  </div>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElTooltip } from "element-plus";
import { IconInfoCircle } from "@tabler/icons-vue";
import imageInpaintPrompt from "../../../scaffold/components/imageInpaintPrompt.vue";
import { useNodeAi, type NodeInpaintInput } from "../../../scaffold/nodeAi";
import { translate } from "@miaoimg/i18n/vue";
import type { usePreparedOutpaint } from "../usePreparedOutpaint";
import { useCanvasToolRegistry } from "../../../canvasToolRegistry";
const props = defineProps<{ controller: ReturnType<typeof usePreparedOutpaint>; generate: (input?: NodeInpaintInput, signal?: AbortSignal) => Promise<void>;
  generating: boolean; pending: boolean; cancel: () => void; disabled?: boolean; target?: HTMLElement }>();
const ai = useNodeAi(), registry = useCanvasToolRegistry(), prompt = ref<InstanceType<typeof imageInpaintPrompt>>();
const points = ref<number | null>(null), loading = ref(false), error = ref("");
let timer: ReturnType<typeof setTimeout> | undefined, request: AbortController | undefined;
function stop() { if (timer) clearTimeout(timer); timer = undefined; request?.abort(); request = undefined; }
watch(() => [prompt.value?.configuration, props.pending, props.controller.active, registry?.bindingVersion(), registry?.scope(), registry?.active()] as const, ([input, pending, active]) => {
  stop(); points.value = null; error.value = ""; loading.value = false;
  if (!active || pending || !registry?.scope() || !registry.active() || !input || !input.prompt.trim()) return;
  props.controller.updateConfig(input);
  loading.value = true;
  const current = request = new AbortController();
  timer = setTimeout(async () => {
    try {
      const prepared = await props.controller.prepare(input, current.signal);
      const quote = await ai.estimateImage(prepared, current.signal);
      current.signal.throwIfAborted();
      if (request !== current) return;
      points.value = typeof quote.points === "number" && Number.isFinite(quote.points) ? quote.points : null;
      if (points.value == null) error.value = translate("预计积分暂不可用，请稍后重试");
    } catch (failure) { if (!current.signal.aborted && request === current) error.value = failure instanceof Error ? failure.message : translate("预计积分暂不可用，请稍后重试"); }
    finally { if (request === current) loading.value = false; }
  }, 250);
}, { immediate: true, flush: "sync" });
onScopeDispose(stop);
const generating = computed(() => props.generating);
function startGeneration(signal?: AbortSignal, toolCall = false) {
  if (!prompt.value) throw new Error(translate("资源尚未就绪，请稍后重试"));
  if (!props.pending && (loading.value || error.value || points.value == null)) throw new Error(translate("请等待预计积分计算完成"));
  return prompt.value.startGeneration(signal, toolCall);
}
defineExpose({ startGeneration, generating });
</script>
<style scoped>
.outpaintEstimate { margin-left:auto; max-width:130px; font-size:12px; color:var(--el-text-color-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.preparedOutpaintHeading { display:flex; align-items:center; gap:4px; margin-bottom:6px; font-size:12px; }
</style>
