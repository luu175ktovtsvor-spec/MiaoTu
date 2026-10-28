import { nodeTools, z } from "./nodeTools";
import { computed, shallowRef, ref } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import type { NodeData } from "./connection";
import { useNodeEvent } from "./nodeEvent";
import { useNodeInputs } from "./nodeInputs";
import type { NodeInputValue } from "./values";
import { referenceKey, orderNodeReferences, nodeReferenceMentions } from "./nodeReferences";
import { isPromptModel, normalizePromptModel, getPromptText, assertPromptReferencesConnected } from "./promptModel";
import { isNodeOutput } from "./values";
import { isTypeCompatible, validateConnection } from "./connection";
import { translate } from "@miaoimg/i18n/vue";
import { REFERENCE_KINDS, type ReferenceKind } from "./referenceMenu";

export function useNodeReferences(handleId = "in") {
  const { id, node } = useNode<NodeData & { referenceOrder?: Record<string, string[]>; prompt?: string; promptModel?: unknown }>();
  const canvas = useVueFlow();
  const { removeEdges, findNode } = canvas;
  const { getTargetValues } = useNodeInputs(canvas);
  const inputValues = shallowRef<NodeInputValue[]>([]);
  const previews = ref(new Map<string, string>());
  const refList = computed({
    get() {
      return orderNodeReferences(inputValues.value, node.data.referenceOrder?.[handleId]);
    },
    set(values: NodeInputValue[]) {
      node.data.referenceOrder = { ...node.data.referenceOrder, [handleId]: values.map(referenceKey) };
    },
  });
  const referenceMentions = computed(() => {
    const sources = new Map(refList.value.map(item => [referenceKey(item), item.source]));
    return nodeReferenceMentions(refList.value, key => previews.value.get(key) || undefined)
      .map(item => ({ ...item, label: findNode(sources.get(item.id)!)?.data?.label || item.name }));
  });
  const referenceKinds = computed(() => {
    const target = node.data.handles?.find(handle => handle.id === handleId && handle.type === "target");
    return target ? REFERENCE_KINDS.filter(kind => isTypeCompatible(kind, target.dataType)) : [];
  });
  // 当前画布中有真实输出、且接收端口支持的素材，也可以由 @ 选入。
  // 候选没有 {{ref N}}，只有完成连线后才分配提交序号。
  const canvasReferenceMentions = computed(() => {
    const target = node.data.handles?.find(handle => handle.id === handleId && handle.type === "target");
    if (!target || !canvas.nodesConnectable.value) return [];
    const connected = new Set(refList.value.map(referenceKey));
    return canvas.getNodes.value.flatMap(source => {
      if (source.id === id || source.connectable === false) return [];
      return (source.data.handles || []).flatMap(handle => {
        if (handle.type !== "source") return [];
        const output = source.data.outputs?.[handle.id];
        if (!isNodeOutput(output) || !["IMAGE", "VIDEO", "AUDIO", "STRING"].includes(output.dataType)
          || !isTypeCompatible(output.dataType, target.dataType) || output.value === "") return [];
        const key = referenceKey({ source: source.id, sourceHandle: handle.id });
        if (connected.has(key)) return [];
        const type = translate(({ IMAGE: "图片", VIDEO: "视频", AUDIO: "音频", STRING: "文本" } as Record<string, string>)[output.dataType]);
        return [{ id: key, name: `${type} · ${source.data.label || type}`, label: source.data.label || type,
          kind: output.dataType as ReferenceKind, media: typeof output.value === "object" ? output.value : undefined }];
      });
    });
  });

  function connectReference(key: string) {
    inputValues.value = getTargetValues(id, handleId);
    const existing = referenceMentions.value.find(item => item.id === key);
    if (existing) return existing;
    if (!canvasReferenceMentions.value.some(item => item.id === key)) throw new Error(translate("素材已变化，请重新选择"));
    const [source, sourceHandle] = JSON.parse(decodeURIComponent(key)) as [string, string];
    const sourceNode = findNode(source), targetNode = findNode(id);
    const connection = { source, sourceHandle, target: id, targetHandle: handleId };
    if (!sourceNode || !targetNode || targetNode.connectable === false
      || !validateConnection(connection, { sourceNode, targetNode, nodes: canvas.getNodes.value, edges: canvas.getEdges.value })) {
      throw new Error(translate("当前节点不支持引用这个素材"));
    }
    // 与手动拖线共用校验及 addEdges，不重复添加，也不绕开模型的接收规则。
    canvas.addEdges({ id: crypto.randomUUID(), ...connection });
    inputValues.value = getTargetValues(id, handleId);
    const reference = referenceMentions.value.find(item => item.id === key);
    if (!reference) throw new Error(translate("素材已变化，请重新选择"));
    return reference;
  }

  function preparePromptReferences() {
    inputValues.value = getTargetValues(id, handleId);
    const initial = isPromptModel(node.data.promptModel) && node.data.promptModel.length ? node.data.promptModel
      : typeof node.data.prompt === "string" ? node.data.prompt.split("\n").map(text => [{ type: "Write" as const, text }]) : [];
    assertPromptReferencesConnected(initial, referenceMentions.value);
    // Resolve current ordinals from stable source IDs in the same stack that
    // captures the request, even before the editor's queued reference refresh.
    const promptModel = normalizePromptModel(initial, referenceMentions.value);
    node.data.promptModel = promptModel;
    node.data.prompt = getPromptText(promptModel);
    return node.data.prompt;
  }

  // 在筛选复制连线前把数字占位符绑定到实际来源，粘贴时才能正确处理缺少的外部输入。
  useNodeEvent().on("copy", () => {
    inputValues.value = getTargetValues(id, handleId);
    const referenceOrder = { ...node.data.referenceOrder, [handleId]: refList.value.map(referenceKey) };
    const initial = isPromptModel(node.data.promptModel) && node.data.promptModel.length ? node.data.promptModel
      : typeof node.data.prompt === "string" ? node.data.prompt.split("\n").map(text => [{ type: "Write" as const, text }]) : undefined;
    if (!initial) return { referenceOrder };
    const promptModel = normalizePromptModel(initial, referenceMentions.value);
    return { referenceOrder, promptModel, prompt: getPromptText(promptModel) };
  });

  // Capture the reference order and user labels at submission time. A later
  // rename, deletion or another browser edit must not change old history.
  function referenceHistory() {
    return refList.value.flatMap((item, index) =>
      typeof item.dataType === "string" && ["IMAGE", "VIDEO", "AUDIO", "STRING"].includes(item.dataType)
        ? [{ index: index + 1, name: String(findNode(item.source)?.data.label || ""), kind: item.dataType }]
        : []
    );
  }

  useNodeEvent().on(`input:${handleId}`, (values) => {
    inputValues.value = values;
    const ids = new Set(values.filter(item => item.dataType === "IMAGE" || item.dataType === "VIDEO").map(referenceKey));
    for (const key of previews.value.keys()) {
      if (!ids.has(key)) previews.value.delete(key);
    }
  });

  function setReferencePreview(item: NodeInputValue, url: string) {
    previews.value.set(referenceKey(item), url);
  }

  function removeReference(item: NodeInputValue) {
    removeEdges(edges => edges.filter(edge =>
      edge.target === id && edge.targetHandle === handleId && edge.source === item.source && edge.sourceHandle === item.sourceHandle
    ));
  }

  nodeTools.register({
    name: 'getReferences', description: '读取当前节点真实输入参考的顺序、源节点、端口、类型与是否有可用内容；不展开媒体或正文。',
    parameters: z.strictObject({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }),
    execute: ({ offset, limit }) => ({ handleId, references: refList.value.slice(offset, offset + limit).map((item, index) => ({ index: offset + index + 1, source: item.source, sourceHandle: item.sourceHandle, dataType: item.dataType, available: item.value !== undefined })), total: refList.value.length, hasMore: offset + limit < refList.value.length, nextOffset: offset + limit < refList.value.length ? offset + limit : null }),
  });
  nodeTools.register({
    name: 'setReferenceOrder', description: '按 source/sourceHandle 重排当前节点所有输入参考，与界面拖动排序相同；mode=replace 时必须完整提供参考；mode=move 可只给需移动的参考，插在 before 前，省略 before 移到末尾，适用于大参考列表分批处理。不新增或删除连线，首尾帧按此顺序解释。',
    parameters: z.strictObject({ references: z.array(z.strictObject({ source: z.string().min(1), sourceHandle: z.string().min(1) })).max(100), mode: z.enum(['replace','move']).default('replace'), before: z.strictObject({ source: z.string().min(1), sourceHandle: z.string().min(1) }).optional() }),
    execute({ references, mode, before }) {
      const current = new Map(refList.value.map(item => [referenceKey(item), item]));
      const keys = references.map(referenceKey);
      if (new Set(keys).size !== keys.length || (mode === 'replace' && keys.length !== current.size) || keys.some(key => !current.has(key))) throw new Error('参考已变化，请先读取 getReferences，并完整提供且不重复');
      const rest = [...current.keys()].filter(key => !keys.includes(key));
      const target = before ? referenceKey(before) : undefined;
      if (target && !rest.includes(target)) throw new Error('before 必须是未被移动的现有参考');
      if (mode === 'move') rest.splice(target ? rest.indexOf(target) : rest.length, 0, ...keys);
      refList.value = (mode === 'move' ? rest : keys).map(key => current.get(key)!);
      return { handleId, references };
    },
  });
  return { refList, referenceMentions, canvasReferenceMentions, referenceKinds, connectReference, referenceHistory, preparePromptReferences, setReferencePreview, removeReference };
}
