<template>
  <span class="modelIcon" :class="{ isMark: Boolean(mark), isFallback: !mark }" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.5)}px` }" aria-hidden="true">
    <span v-if="mark" class="modelMark" v-html="mark" />
    <template v-else>{{ initial }}</template>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { modelLogoSvg } from "../assets/model-logos";

const props = withDefaults(defineProps<{ model: string; provider?: string; size?: number }>(), { size: 16, provider: "" });
const mark = computed(() => modelLogoSvg(props.model, props.provider));
const initial = computed(() => Array.from(String(props.provider || props.model || "AI").trim())[0]?.toUpperCase() || "A");
</script>

<style scoped>
.modelIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  line-height: 1;
}
.modelMark,
.modelMark :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.modelIcon.isMark { color: var(--el-text-color-primary, currentColor); }
.modelIcon.isFallback {
  border-radius: 30%;
  background: var(--el-fill-color, rgba(255, 255, 255, .08));
  box-shadow: inset 0 0 0 1px var(--el-border-color, rgba(255, 255, 255, .12));
  color: var(--el-text-color-regular, currentColor);
  font-weight: 650;
}
</style>
