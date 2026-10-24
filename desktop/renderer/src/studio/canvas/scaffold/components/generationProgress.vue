<template>
  <!-- 生成进度画在节点预览框的底部：蓝色进度条从左往右推进，百分比跟着进度条的头走，发蓝光。
       不遮住整张预览，只在底部加一层渐暗保证文字看得清；不依赖节点是否被选中，也不依赖悬停。 -->
  <div v-if="progress.visible" class="generationProgress" :class="`phase-${progress.phase}`">
    <div class="progressInfo">
      <span class="progressLabel">{{ progress.label }}</span>
      <span v-if="progress.detail" class="progressDetail">{{ progress.detail }}</span>
      <span v-if="progress.message || progress.hint" class="progressNote">{{ progress.message || progress.hint }}</span>
    </div>
    <div
      class="progressTrack"
      role="progressbar"
      :aria-label="label"
      :aria-valuetext="progress.text"
      v-bind="progress.showPercent ? { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': progress.percent } : {}">
      <div class="progressFill" :style="{ width: `${fillWidth}%` }" />
      <span v-if="progress.showPercent" class="progressNumber" :style="{ left: `${numberLeft}%` }">{{ numberText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { useGenerationProgress } from "../generationProgress";

// 组件只负责画；进度怎么算在 generationProgressCore，生命周期在 useGenerationProgress。
const props = defineProps<{
  progress: ReturnType<typeof useGenerationProgress>;
  label: string;
}>();

// 失败、取消、停止等待没有完成比例：条子铺满并换成状态色，不显示数字。
const fillWidth = computed(() => (props.progress.showPercent ? Math.max(2, props.progress.percent) : 100));
// 数字贴着进度条的头，两端各留一点位置，不被预览框裁掉。
const numberLeft = computed(() => Math.min(94, Math.max(6, props.progress.percent)));
const numberText = computed(() => `${props.progress.estimated ? "≈" : ""}${props.progress.percent}%`);
</script>

<style scoped lang="scss">
.generationProgress {
  --progress-flow: #4c9dff;
  position: absolute;
  inset: auto 0 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 40px 14px 14px;
  // 预览区里有图片编辑器等交互元素，进度只是显示，不能挡住它们。
  pointer-events: none;
  background: linear-gradient(180deg, transparent, rgb(0 0 0 / .62) 70%);
  color: #fff;
}

.progressInfo {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  font-size: 12px;
  line-height: 16px;
  text-shadow: 0 1px 2px rgb(0 0 0 / .5);
}
.progressLabel { font-weight: 600; letter-spacing: .02em; }
.progressDetail { color: rgb(255 255 255 / .72); font-variant-numeric: tabular-nums; }
.progressNote {
  display: -webkit-box;
  flex-basis: 100%;
  overflow: hidden;
  color: rgb(255 255 255 / .72);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.progressTrack {
  position: relative;
  height: 4px;
  margin-bottom: 14px;
  border-radius: 999px;
  background: rgb(255 255 255 / .16);
}
.progressFill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, rgb(76 157 255 / .55), var(--progress-flow));
  box-shadow: 0 0 10px rgb(76 157 255 / .85), 0 0 2px rgb(76 157 255 / .9);
  transition: width .6s cubic-bezier(.2, .7, .2, 1), background .3s, box-shadow .3s;
}
.progressNumber {
  position: absolute;
  top: 8px;
  transform: translateX(-50%);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-shadow: 0 0 8px rgb(76 157 255 / .9), 0 1px 2px rgb(0 0 0 / .5);
  transition: left .6s cubic-bezier(.2, .7, .2, 1);
}

// 排队：还没开跑，条子上有一道光来回扫，表示在排队、不是卡住了。
.phase-queued .progressFill {
  width: 100% !important;
  background: linear-gradient(90deg, transparent, rgb(76 157 255 / .9), transparent) 0 0 / 40% 100% no-repeat;
  box-shadow: none;
  animation: progress-scan 1.6s ease-in-out infinite;
}
.phase-queued .progressNumber { display: none; }
.phase-succeeded .progressFill { background: var(--progress-flow); }
.phase-failed .progressFill { background: #e5484d; box-shadow: 0 0 10px rgb(229 72 77 / .7); }
:is(.phase-cancelled, .phase-pending) .progressFill { background: rgb(255 255 255 / .45); box-shadow: none; }

@keyframes progress-scan {
  0% { background-position: -40% 0; }
  100% { background-position: 140% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .progressFill, .progressNumber { transition: none; }
  .phase-queued .progressFill { animation: none; background: rgb(76 157 255 / .5); }
}
</style>
