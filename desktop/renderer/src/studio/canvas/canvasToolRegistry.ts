import { inject, nextTick, onScopeDispose, shallowRef, watch, type Ref } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { createBoundActionRegistry, type ActionBinding, type BoundActionContext } from "./boundActionRegistry";
import { canvasTools, toolCapability, type CanvasToolId } from "./canvasToolCatalogue";
import { loadMediaModels, type NodeMediaModel } from "./scaffold/nodeAi";
import { translate } from "@miaoimg/i18n/vue";

export function createCanvasToolRegistry(context: ActionBinding) {
  const models = shallowRef<NodeMediaModel[]>([]);
  const recent = shallowRef<CanvasToolId[]>([]);
  const disposed = shallowRef(false);
  let bindingRevision = 0;
  const registry = createBoundActionRegistry(context, canvasTools.map(tool => tool.id));
  const stop = watch(context.scope, () => { bindingRevision++; models.value = []; recent.value = []; }, { flush: "sync" });
  return {
    ...registry, models, recent,
    scope: () => disposed.value ? "" : context.scope(),
    bindingVersion: () => bindingRevision,
    active: () => !disposed.value && context.active(),
    async refresh() {
      if (disposed.value || !context.active() || !context.scope()) return;
      const scope = context.scope();
      const revision = bindingRevision;
      const result = await loadMediaModels(true);
      if (!disposed.value && revision === bindingRevision && scope && scope === context.scope() && context.active()) models.value = result;
    },
    remember(id: CanvasToolId) { if (!disposed.value) recent.value = [id, ...recent.value.filter(item => item !== id)].slice(0, 6); },
    dispose() { disposed.value = true; stop(); registry.dispose(); models.value = []; recent.value = []; },
  };
}
export type CanvasToolRegistry = ReturnType<typeof createCanvasToolRegistry>;
export const canvasToolRegistryKey = "canvasToolActions";
export function useCanvasToolRegistry() { return inject<CanvasToolRegistry | undefined>(canvasToolRegistryKey, undefined); }

export function useRegisterCanvasTools(node: GraphNode, handler: {
  available: (tool: CanvasToolId) => boolean;
  beforeOpen?: (tool: CanvasToolId) => unknown | Promise<unknown>;
  ready: (tool: CanvasToolId) => boolean;
  run: (tool: CanvasToolId, context: BoundActionContext) => unknown | Promise<unknown>;
}) {
  const registry = useCanvasToolRegistry();
  const active = inject<Ref<boolean> | undefined>("canvasUiActive", undefined);
  const flow = useVueFlow();
  if (!registry) return;
  const available = (tool: CanvasToolId) => active?.value === true && toolCapability(tool, registry.models.value) && handler.available(tool);
  const unregister = registry.register(node, {
    available,
    async run(tool, context) {
      context.assertCurrent();
      flow.removeSelectedElements();
      flow.addSelectedNodes([node]);
      await handler.beforeOpen?.(tool);
      await nextTick();
      context.assertCurrent();
      await flow.fitView({ nodes: [node.id], padding: 0.5, maxZoom: 1, duration: 150 });
      for (let frame = 0; !handler.ready(tool) && frame < 60; frame++) {
        context.assertCurrent();
        if (!available(tool)) throw new Error(translate("功能暂不可用，请重新选择"));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      context.assertCurrent();
      if (!available(tool)) throw new Error(translate("功能暂不可用，请重新选择"));
      if (!handler.ready(tool)) throw new Error(translate("资源尚未就绪，请稍后重试"));
      return handler.run(tool, context);
    },
  });
  onScopeDispose(unregister);
}

// Existing popovers accept MouseEvent.currentTarget. Keep the node anchor alive
// after the palette closes instead of anchoring to an unmounted dialog button.
export function canvasToolAnchor(node: GraphNode, host?: HTMLElement | null): MouseEvent {
  const element = host?.querySelector<HTMLElement>(`.vue-flow__node[data-id="${CSS.escape(node.id)}"]`);
  const rect = element?.getBoundingClientRect() ?? new DOMRect(innerWidth / 2, innerHeight / 2, 1, 1);
  const anchor = { getBoundingClientRect: () => rect, focus: () => element?.focus({ preventScroll: true }) };
  return { currentTarget: anchor } as unknown as MouseEvent;
}
