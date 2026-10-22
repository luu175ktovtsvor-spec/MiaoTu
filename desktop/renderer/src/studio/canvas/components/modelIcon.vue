<template>
  <span class="modelIcon" :class="family" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.5)}px` }" aria-hidden="true">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from "vue";

// 按模型家族给不同徽标：妙图模型目录里的几家各自一个字母 + 颜色，便于在列表里一眼区分。
const props = withDefaults(defineProps<{ model: string; size?: number }>(), { size: 16 });
const family = computed(() => {
  const model = String(props.model || "").toLowerCase();
  if (/grok/.test(model)) return "grok";
  if (/seedream|seedance|doubao|volc/.test(model)) return "seed";
  if (/gpt|openai|chatgpt|codex/.test(model)) return "gpt";
  if (/qwen|wanx|wanvideo|tongyi/.test(model)) return "qwen";
  if (/claude|anthropic/.test(model)) return "claude";
  return "other";
});
const label = computed(() => ({ gpt: "G", grok: "X", seed: "豆", qwen: "Q", claude: "C", other: "AI" }[family.value]));
</script>

<style scoped>
.modelIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 50%;
  font-weight: 700;
  line-height: 1;
  color: #0b0c0e;
  background: #c4c2ba;
}
.modelIcon.gpt { background: #10a37f; color: #fff; }
.modelIcon.grok { background: #1b1b1f; color: #fff; border: 1px solid rgba(255, 255, 255, .35); }
.modelIcon.seed { background: #2f6bff; color: #fff; }
.modelIcon.qwen { background: #6f42c1; color: #fff; }
.modelIcon.claude { background: #d97757; color: #fff; }
.modelIcon.other { background: var(--el-color-primary, #f2f2f2); color: var(--canvas-accent-ink, #151515); }
</style>
