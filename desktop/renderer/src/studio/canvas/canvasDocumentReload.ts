import { nextTick } from "vue";
import type { useVueFlow } from "@vue-flow/core";
import type { useNodeToolsContext } from "./scaffold/nodeTools";
import { waitForNodeRuntime } from "./nodeRuntime";
import { translate } from "@miaoimg/i18n/vue";

// A document pane and its node can have independent drafts. Reload through the
// owning node's declared capability, without flushing stale text to disk first.
export async function reloadCanvasNodeText(flow: ReturnType<typeof useVueFlow>, tools: ReturnType<ReturnType<typeof useNodeToolsContext>>,
  nodeId: string, handleId: string, savedText: string, draftText: string,
  state: () => { dirty: boolean; error: string } | undefined, signal: AbortSignal) {
  await waitForNodeRuntime(flow, nodeId, signal);
  signal.throwIfAborted();
  const node = flow.findNode(nodeId);
  const output = node?.data.outputs?.[handleId];
  if (!node || output?.dataType !== "STRING" || typeof output.value !== "string") throw new Error(translate("节点没有文本输出"));
  // A failed pane save may already have updated the owning node. Both the
  // last read text and the confirmed pane draft are known to this editor.
  if (output.value !== savedText && output.value !== draftText && state()?.dirty !== false) throw new Error(translate("文档内容已变化，请重新读取后编辑"));
  if (![...tools.list([nodeId])].some(tool => tool.name === "node:reloadText")) throw new Error(translate("此节点不支持重新读取磁盘正文"));
  const result = await tools.call({ nodeId, name: "node:reloadText", args: { expectedText: output.value } }, signal);
  await nextTick();
  signal.throwIfAborted();
  if (flow.findNode(nodeId) !== node || typeof result !== "object" || result === null || !("text" in result) || typeof result.text !== "string"
    || node.data.outputs?.[handleId]?.value !== result.text) throw new Error(translate("文档内容已变化，请重新读取后编辑"));
  return node;
}
