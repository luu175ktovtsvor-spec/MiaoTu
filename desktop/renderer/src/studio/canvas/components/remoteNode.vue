<template>
  <nodeSkeleton v-if="loading" loading :label="node.data.label || node.type" :handles="node.data.handles" :outputs="node.data.outputs" />
  <Suspense v-else-if="component && !error && !runtimeError" @pending="componentMounted = false" @resolve="componentMounted = true">
    <component :is="component" v-bind="$attrs" :node="node" />
    <template #fallback><nodeSkeleton loading :label="node.data.label || node.type" :handles="node.data.handles" :outputs="node.data.outputs" /></template>
  </Suspense>
  <el-card v-else class="remoteNodeState failed" shadow="never" role="alert">
    <div class="stateHeader">
      <strong>{{ node.data.label || node.type }}</strong>
      <span class="stateLabel">error</span>
      <div class="stateActions nodrag nopan" @pointerdown.stop @mousedown.stop @dblclick.stop>
        <el-button :icon="IconRefresh" text :loading="reloading" :title="translate('重新加载节点')" :aria-label="translate('重新加载节点')" @click.stop="retry" />
        <el-button :icon="IconX" text :title="translate('移除节点')" :aria-label="translate('移除节点')" @click.stop="removeNodes(node.id)" />
      </div>
    </div>
    <p>{{ error || runtimeError || translate("远程节点未加载，请确认插件已安装并启用") }}</p>
  </el-card>
</template>

<script setup lang="ts">
import { inject, onErrorCaptured, onScopeDispose, ref, watch, Suspense, type Component } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { ElButton, ElCard } from "element-plus";
import { IconRefresh, IconX } from "@tabler/icons-vue";
import { nodeSkeleton, type NodeData } from "@miaoimg/nodes-scaffold/runtime";
import { translate } from "@miaoimg/i18n/vue";
import { nodeRuntimeStates } from '../nodeRuntime';

defineOptions({ inheritAttrs: false });
const props = defineProps<{ component?: Component | string; error?: string; loading?: boolean }>();
const { node } = useNode<NodeData>();
const flow = useVueFlow();
const { removeNodes } = flow;
const reload = inject<((type: string) => Promise<void>)>("reloadRemoteNode");
const runtimeError = ref("");
// 等 Vue 的异步分支 resolve；包装器和 loadingComponent 的挂载都不能代表实际节点已经就绪。
const componentMounted = ref(false);
const reloading = ref(false);
const states = nodeRuntimeStates(flow);
watch(() => props.component, () => { componentMounted.value = false; }, { flush: 'sync' });
watch(() => [props.loading, props.error, props.component, runtimeError.value, componentMounted.value] as const, () => {
  states.set(node.id, { loading: !!props.loading || !componentMounted.value, error: props.error || runtimeError.value || (!props.loading && !props.component ? '远程节点未加载，请确认插件已安装并启用' : ''), ready: componentMounted.value });
}, { immediate: true, flush: 'post' });
onScopeDispose(() => states.delete(node.id));

onErrorCaptured(error => {
  runtimeError.value = error instanceof Error ? error.message : String(error);
  console.error(`远程节点 ${node.type} (${node.id}) 运行失败`, error);
  return false;
});
watch(() => props.component, () => { runtimeError.value = ""; });

async function retry() {
  if (!reload || reloading.value) return;
  reloading.value = true;
  try { await reload(node.type); }
  catch (error) { runtimeError.value = error instanceof Error ? error.message : String(error); }
  finally { reloading.value = false; }
}
</script>

<style scoped lang="scss">
.remoteNodeState {
  width: 320px;
  &.failed { border-color: var(--el-color-danger); }
  .stateHeader {
    display: flex;
    align-items: center;
    gap: 8px;
    strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .stateLabel { font-size: 12px; color: var(--el-text-color-secondary); }
    .stateActions {
      display: flex;
      .el-button { width: 28px; height: 28px; margin: 0; padding: 0; }
    }
  }
  &.failed .stateLabel { color: var(--el-color-danger); }
  p { margin: 10px 0 0; font-size: 12px; color: var(--el-text-color-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
}
</style>
