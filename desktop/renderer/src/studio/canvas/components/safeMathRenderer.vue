<template>
  <component v-if="error" :is="errorComponent" variant="katex" :message="errorMessage" />
  <div v-else-if="node.type === 'math'" data-stream-markdown="math" class="my-4 text-center" v-html="safeHtml" />
  <span v-else data-stream-markdown="inline-math" v-html="safeHtml" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useContext, useMathRenderer } from "vue-stream-markdown";
import type { InlineMathNode, MathNode } from "vue-stream-markdown";
// Load the parser's existing math-node augmentation for its public node types.
import type {} from "mdast-util-math";
import { sanitizeMathHtml } from "./sanitizeMathHtml";

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ node: MathNode | InlineMathNode; throttle?: number }>(), { throttle: 300 });
const { cdnOptions, katexOptions, uiComponents } = useContext();
// Preserve the upstream renderer's streaming, throttling and error behavior;
// only its HTML publication is replaced with a sanitized value.
const { html, error, errorMessage } = useMathRenderer({
  node: () => props.node,
  throttle: () => props.throttle,
  katexOptions,
  cdnOptions: cdnOptions.value,
});
const errorComponent = computed(() => katexOptions.value?.errorComponent ?? uiComponents.value.ErrorComponent);
const safeHtml = computed(() => sanitizeMathHtml(html.value));
</script>
