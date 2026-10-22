<template>
  <!-- 生成进度画在节点的预览框里：环形 + 中间的数字百分比，不依赖节点是否被选中，也不依赖悬停。 -->
  <div v-if="progress.visible" class="generationProgress" :class="`phase-${progress.phase}`" role="status">
    <el-progress
      v-if="progress.showPercent"
      class="progressRing"
      type="circle"
      :percentage="progress.percent"
      :width="64"
      :stroke-width="3"
      :color="ringColor"
      :aria-label="label"
      :aria-valuetext="progress.text">
      <span class="ringText">{{ numberText }}</span>
    </el-progress>
    <!-- Element Plus 的 progress 会强制写 aria-valuenow；失败/取消必须换成没有数值语义的状态环。 -->
    <div v-else class="progressRing progressRingStatus" role="progressbar" :aria-label="label" :aria-valuetext="progress.text" :style="{ color: ringColor }">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="statusRingTrack" cx="50" cy="50" r="46" />
        <circle class="statusRingPath" cx="50" cy="50" r="46" />
      </svg>
    </div>
    <div class="progressLine">
      <span class="progressLabel">{{ progress.label }}</span>
      <span v-if="progress.detail" class="progressDetail">{{ progress.detail }}</span>
    </div>
    <div v-if="progress.message || progress.hint" class="progressNote">{{ progress.message || progress.hint }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElProgress } from "element-plus";
import type { useGenerationProgress } from "../generationProgress";

// 组件只负责画；进度怎么算在 generationProgressCore，生命周期在 useGenerationProgress。
const props = defineProps<{
  progress: ReturnType<typeof useGenerationProgress>;
  label: string;
}>();

// 生成中用画布浅蓝强调色，排队/取消保持中性灰，终态用状态色。
const RING_COLORS: Record<string, string> = {
  queued: "#9aa0a6",
  running: "var(--el-color-primary, #f2f2f2)",
  saving: "var(--el-color-primary, #f2f2f2)",
  succeeded: "#34d399",
  failed: "#f87171",
  cancelled: "#9aa0a6",
  pending: "#9aa0a6",
};
const ringColor = computed(() => RING_COLORS[props.progress.phase] ?? "var(--el-color-primary, #f2f2f2)");
const showNumber = computed(() => props.progress.showPercent);
const numberText = computed(() => (showNumber.value ? `${props.progress.estimated ? "≈" : ""}${props.progress.percent}%` : ""));
</script>

<style scoped lang="scss">
.generationProgress {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px;
  // 预览区里有图片编辑器等交互元素，进度只是显示，不能挡住它们。
  pointer-events: none;
  background: rgba(0, 0, 0, 0.68);
  color: #fff;
  text-align: center;

  .progressRing {
    --el-text-color-primary: #fff;

    :deep(.el-progress__text) {
      color: #fff;
      font-size: 14px !important;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
  }

  .progressRingStatus {
    width: 64px;
    height: 64px;

    svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    circle { fill: none; stroke-width: 5; }
    .statusRingTrack { stroke: rgba(255, 255, 255, 0.2); }
    .statusRingPath { stroke: currentColor; stroke-dasharray: 0 289; }
  }

  .progressLine {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: center;
    gap: 2px 6px;
    font-size: 12px;
    line-height: 16px;
  }

  .progressLabel {
    font-weight: 600;
  }

  .progressDetail {
    color: rgba(255, 255, 255, 0.72);
  }

  .progressNote {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    font-size: 12px;
    line-height: 16px;
    color: rgba(255, 255, 255, 0.72);
  }

  // 排队：还没有开跑，用中性灰 + 呼吸感说明「在排队，不是卡住了」。
  &.phase-queued .progressRing {
    animation: progress-pulse 1.8s ease-in-out infinite;
  }
}

@keyframes progress-pulse {
  0%, 100% { opacity: 0.65; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .generationProgress.phase-queued .progressRing {
    animation: none;
    opacity: 0.85;
  }
}
</style>
