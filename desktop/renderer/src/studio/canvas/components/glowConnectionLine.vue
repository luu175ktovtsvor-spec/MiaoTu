<template>
  <g class="glowConnection" :stroke="flowColor" fill="none">
    <path class="vue-flow__connection-path glowConnectionCore" :d="path[0]" />
    <path v-for="(layer, index) in EDGE_FLOW_LAYERS" :key="index" :d="path[0]" pathLength="300" :stroke-dasharray="layer.dash" :stroke-width="layer.width" :stroke-opacity="layer.opacity" :stroke-linecap="layer.cap" />
  </g>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { getSimpleBezierPath, type Position } from "@vue-flow/core";
import { generalSettings } from "@/stores/settings";
import { EDGE_FLOW_DEFAULT_COLOR, EDGE_FLOW_LAYERS } from "./edgeFlow";

// 拖线时整条线发光，光点从起点往外流，和 LibTV 拖线的样子一致。
const props = defineProps<{ sourceX: number; sourceY: number; targetX: number; targetY: number; sourcePosition: Position; targetPosition: Position }>();
const path = computed(() => getSimpleBezierPath(props));
const flowColor = computed(() => generalSettings.value.canvasEdgeColorMode === "custom" ? generalSettings.value.canvasEdgeColor : EDGE_FLOW_DEFAULT_COLOR);
</script>

<style scoped>
.glowConnection { pointer-events: none; animation: connection-flow-travel 1.6s linear infinite; }
.glowConnection > path:not(.glowConnectionCore) { stroke-dashoffset: inherit; }
.glowConnection .glowConnectionCore { stroke: inherit !important; stroke-width: 2px !important; stroke-opacity: .85 !important; }
@keyframes connection-flow-travel { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -300px; } }
@media (prefers-reduced-motion: reduce) { .glowConnection { animation: none; } }
</style>
