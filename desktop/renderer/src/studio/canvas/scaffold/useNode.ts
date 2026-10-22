import { computed, getCurrentInstance, inject, readonly, ref, watch, type Component, type Ref } from "vue";
import { useNode as useFlowNode, useVueFlow } from "@vue-flow/core";
import type { NodeDocumentContext } from "./nodeDocument";
import { isTypeCompatible, type NodeData, type NodeHandle } from "./connection";
import { isNodeOutput, type NodeOutputs } from "./values";
import { useNodeEvent } from "./nodeEvent";
import { nodeTools } from "./nodeTools";
import { useNodeFiles, retainNodeMedia } from "./workspaceFiles";
import { useNodeAi } from "./nodeAi";
import { useNodeFfmpeg } from "./nodeFfmpeg";
import { useNodePreviewReady } from "./useNodePreviewReady";

export type NodeOptions<T extends NodeOutputs = NodeOutputs> = {
  label?: string;
  icon?: Component;
  handles?: NodeHandle[];
  outputs?: T;
};

export function useNode<T extends NodeOutputs = NodeOutputs>(options: NodeOptions<T> = {}) {
  const { id, node } = useFlowNode<NodeData>();
  const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
  const getNodeConfig = inject<((nodeType: string) => Record<string, unknown>) | undefined>("nodeConfig", undefined);
  const config = computed(() => readonly(getNodeConfig?.(node.type ?? "") ?? {}));
  const previewReady = useNodePreviewReady();
  const { updateNodeInternals } = useVueFlow();
  const defaults = getCurrentInstance()?.type as Pick<NodeOptions, "handles" | "icon"> | undefined;
  const handles = ref<NodeHandle[]>(options.handles ?? structuredClone(defaults?.handles ?? []));
  const compatibleOutputs = (value: unknown) => Object.fromEntries(Object.entries(value ?? {}).filter(([handleId, output]) => {
    const handle = handles.value.find(item => item.type === "source" && item.id === handleId);
    const defaultOutput = options.outputs?.[handleId];
    return handle && isNodeOutput(output) && isTypeCompatible(output.dataType, handle.dataType)
      && (!defaultOutput || defaultOutput.dataType === output.dataType);
  }));
  const outputs = ref({ ...options.outputs, ...compatibleOutputs(node.data.outputs) }) as Ref<T>;
  // 后台取回结果、撤销和其他页面更新都会替换画布快照；已挂载节点也要采用新输出。
  // 本节点写回时共享同一个引用，避免来回复制或覆盖尚未保存的本地输出。
  watch(() => node.data.outputs, value => {
    if (value !== outputs.value) outputs.value = { ...options.outputs, ...compatibleOutputs(value) } as T;
  }, { flush: "sync" });
  const nodeProps = computed(() => ({
    previewReady: previewReady.value,
    label: node.data.label ?? options.label,
    icon: options.icon ?? defaults?.icon,
    handles: handles.value,
    outputs: outputs.value,
  }));
  const nodeEvent = useNodeEvent();
  const { getWorkspaceFiles, uploadFile, removeNodeFiles, useFileUrl } = useNodeFiles();

  return {
    id,
    node,
    config,
    previewReady,
    nodeProps,
    handles,
    outputs,
    nodeEvent,
    nodeTools,
    ai: useNodeAi(),
    ffmpeg: useNodeFfmpeg(),
    files: {
      getWorkspaceFiles,
      useFileUrl,
      uploadFile: (file: File) => uploadFile(id, file),
      retainMedia: (path: string, kind: 'image' | 'video' | 'audio', signal?: AbortSignal, mimeHint?: string) => retainNodeMedia(getWorkspaceFiles(), id, path, kind, signal, mimeHint),
      removeNodeFiles: () => removeNodeFiles(id),
    },
    updateNodeInternals: () => {
      if (!documentContext?.targets.has(id)) updateNodeInternals([id]);
    },
  };
}
