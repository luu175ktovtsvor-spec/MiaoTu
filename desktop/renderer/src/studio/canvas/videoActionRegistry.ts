import { inject, onScopeDispose, type Ref } from "vue";
import type { GraphNode } from "@vue-flow/core";
import { createBoundActionRegistry, type ActionBinding } from "./boundActionRegistry";

export type VideoAction = "capture" | "extractAudio" | "separate" | "trim";
type VideoActionHandler = { available: () => boolean; run: (action: VideoAction) => unknown | Promise<unknown> };
export function createVideoActionRegistry(context: ActionBinding) {
  const actions: VideoAction[] = ["capture", "extractAudio", "separate", "trim"];
  const registry = createBoundActionRegistry(context, actions);
  return {
    available: (node: GraphNode) => registry.available(node, "capture"),
    register: (node: GraphNode, handler: VideoActionHandler) => registry.register(node, {
      available: () => handler.available(), run: action => handler.run(action),
    }),
    run: registry.run,
    dispose: registry.dispose,
  };
}

type VideoActionRegistry = ReturnType<typeof createVideoActionRegistry>;
// Built-in nodes can also be refreshed as separate script bundles.
export const videoActionRegistryKey = "canvasVideoActions";

export function useVideoActionRegistry() {
  return inject<VideoActionRegistry | undefined>(videoActionRegistryKey, undefined);
}

export function useRegisterVideoActions(node: GraphNode, handler: VideoActionHandler) {
  const registry = useVideoActionRegistry();
  const active = inject<Ref<boolean> | undefined>("canvasUiActive", undefined);
  if (!registry) return;
  const unregister = registry.register(node, {
    available: () => active?.value === true && handler.available(),
    run: handler.run,
  });
  onScopeDispose(unregister);
}
