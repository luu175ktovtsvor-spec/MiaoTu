<template>
  <!-- 所有节点空着时同一个样子（照 LibTV）：中间一个大的类型图标，下面「尝试：」列出这个节点能做的几件事。 -->
  <div class="mediaEmpty nodeEmptyState" :aria-label="label">
    <component :is="icon" :size="48" stroke="1.25" aria-hidden="true" />
    <div v-if="hints.length" class="emptyHints nodrag nopan" role="group" :aria-label="translate('尝试')">
      <span class="emptyHintsTitle">{{ translate('尝试：') }}</span>
      <button v-for="hint in hints" :key="hint.key" type="button" class="emptyHint" :disabled="disabled || hint.disabled" @pointerdown.stop @dblclick.stop @click.stop="emit('pick', hint.key)">
        <component :is="hint.icon" :size="16" aria-hidden="true" />{{ translate(hint.label) }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Component } from "vue";
import { translate } from "@miaoimg/i18n/vue";

export type EmptyHint = { key: string; label: string; icon: Component; disabled?: boolean };
defineProps<{ icon: Component; hints: EmptyHint[]; label?: string; disabled?: boolean }>();
const emit = defineEmits<{ pick: [key: string] }>();
</script>

<style scoped>
.nodeEmptyState { display: grid; place-items: center; align-content: center; gap: 18px; width: 100%; min-height: 144px; padding: 20px 0; color: var(--el-text-color-placeholder); }
</style>
