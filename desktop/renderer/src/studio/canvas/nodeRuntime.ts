import { canvasInjectionKey } from '../../../../../server/canvas-document.ts'
import type { useVueFlow } from '@vue-flow/core';
import { waitForControlValue } from '@/lib/mcpControl';

const runtimeKey = canvasInjectionKey('miaoimg.nodeRuntime');
type State = { loading: boolean; error: string; ready: boolean };
export function nodeRuntimeStates(flow: ReturnType<typeof useVueFlow>) {
  const host = flow as typeof flow & { [runtimeKey]?: Map<string, State> };
  if (!host[runtimeKey]) Object.defineProperty(host, runtimeKey, { value: new Map<string, State>() });
  return host[runtimeKey]!;
}
export async function waitForNodeRuntime(flow: ReturnType<typeof useVueFlow>, id: string, signal: AbortSignal) {
  if (!flow.findNode(id)?.type?.startsWith('remote-')) return;
  await waitForControlValue(() => {
    const node = flow.findNode(id);
    if (!node) throw new Error(`节点已移除：${id}`);
    const state = nodeRuntimeStates(flow).get(id);
    if (state?.error) throw new Error(`节点加载失败：${state.error}`);
    return state?.ready && !state.loading ? true : undefined;
  }, signal);
}
