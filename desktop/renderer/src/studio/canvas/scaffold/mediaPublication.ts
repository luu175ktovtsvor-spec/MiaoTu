import { inject, onScopeDispose } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import type { NodeOutputs } from "./values";

type MediaNode = { id: string; type?: string; data: Record<string, unknown> };

function mediaOutputs(outputs: NodeOutputs | undefined) {
  return Object.keys(outputs ?? {}).sort().flatMap(handle => {
    const output = outputs?.[handle];
    return output && (output.dataType === "IMAGE" || output.dataType === "VIDEO" || output.dataType === "AUDIO" || output.dataType === "MASK")
      ? [[handle, output.dataType, output.value.url, output.value.mimeType]] : [];
  });
}

function mediaState(node: MediaNode, outputs: NodeOutputs | undefined) {
  return JSON.stringify([node.type, mediaOutputs(outputs), node.data.taskRequestId, node.data.taskOutputPath, node.data.taskExtraNodeIds]);
}

// Labels and other metadata can change while a file is being retained. Only
// the media selection and its generation owner determine who may publish it.
export function captureMediaPublication(node: MediaNode, findNode: (id: string) => unknown, outputs: () => NodeOutputs | undefined, initialUpload = false) {
  const baseline = mediaState(node, outputs());
  // A pending upload mounted for the first time belongs to a new empty node.
  // Its original selection cannot be reconstructed from a later populated node.
  const unknownBaseline = initialUpload && (mediaOutputs(outputs()).length > 0
    || [node.data.taskRequestId, node.data.taskOutputPath, node.data.taskExtraNodeIds].some(value => value !== undefined));
  return (signal?: AbortSignal, savedPath?: string) => {
    signal?.throwIfAborted();
    if (unknownBaseline || findNode(node.id) !== node || mediaState(node, outputs()) !== baseline) {
      throw Object.assign(new Error("节点素材或生成任务已变化，请重新操作" + (savedPath ? `；素材已保留：${savedPath}` : "")), {
        response: { status: 409 }, ...(savedPath ? { savedPath } : {}),
      });
    }
  };
}

export function useMediaPublication(outputs?: () => NodeOutputs | undefined) {
  const { node } = useNode();
  const { findNode } = useVueFlow();
  const getCanvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
  const lifetime = new AbortController();
  onScopeDispose(() => lifetime.abort());
  return (initialUpload = false) => {
    const canvasSignal = getCanvasSignal?.();
    const check = captureMediaPublication(node, findNode, outputs ?? (() => node.data.outputs), initialUpload);
    return (signal?: AbortSignal, savedPath?: string) => {
      lifetime.signal.throwIfAborted();
      canvasSignal?.throwIfAborted();
      check(signal, savedPath);
    };
  };
}
