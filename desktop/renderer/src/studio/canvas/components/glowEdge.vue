<template>
  <BaseEdge :id="id" :path="path[0]" :markerEnd="markerEnd" :style="style" :interactionWidth="interactionWidth" />
  <g v-if="active" class="edgeFlow" :class="{ moving: generalSettings.canvasEdgeAnimationEnabled }" :stroke="flowColor" fill="none" aria-hidden="true">
    <path class="edgeFlowCore" :d="path[0]" :stroke-width="1.6" />
    <path v-for="(layer, index) in EDGE_FLOW_LAYERS" :key="index" :d="path[0]" pathLength="300" :stroke-dasharray="layer.dash" :stroke-width="layer.width" :stroke-opacity="layer.opacity" :stroke-linecap="layer.cap" />
  </g>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { BaseEdge, getSimpleBezierPath, type GraphNode, type Position } from "@vue-flow/core";
import { generalSettings } from "@/stores/settings";
import { EDGE_FLOW_DEFAULT_COLOR, EDGE_FLOW_LAYERS } from "./edgeFlow";

const props = defineProps<{
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  sourceNode: GraphNode;
  targetNode: GraphNode;
  markerEnd?: string;
  style?: Record<string, string | number>;
  interactionWidth?: number;
}>();

const path = computed(() => getSimpleBezierPath(props));
// 和 LibTV 一样：选中或拖动某个节点时，跟它相连的线才发光。
const active = computed(() => generalSettings.value.canvasEdgeColorMode !== "none"
  && Boolean(props.sourceNode?.selected || props.sourceNode?.dragging || props.targetNode?.selected || props.targetNode?.dragging));
const flowColor = computed(() => generalSettings.value.canvasEdgeColorMode === "custom" ? generalSettings.value.canvasEdgeColor : EDGE_FLOW_DEFAULT_COLOR);
</script>

<style scoped>
.edgeFlow { pointer-events: none; }
.edgeFlowCore { stroke-opacity: 0.9; }
.edgeFlow.moving { animation: edge-flow-travel 3s linear infinite; }
.edgeFlow > path:not(.edgeFlowCore) { stroke-dashoffset: inherit; }
@keyframes edge-flow-travel { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -300px; } }
@media (prefers-reduced-motion: reduce) { .edgeFlow.moving { animation: none; } }
</style>
