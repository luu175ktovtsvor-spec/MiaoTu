import { shallowReactive, watch } from "vue";
import type { GraphNode } from "@vue-flow/core";
import { translate } from "@miaoimg/i18n/vue";

export type ActionBinding = { scope: () => string; active: () => boolean; findNode: (id: string) => GraphNode | undefined };
export type BoundActionContext = { assertCurrent: () => void };
export type BoundActionHandler<Action extends string> = {
  available: (action: Action) => boolean;
  run: (action: Action, context: BoundActionContext) => unknown | Promise<unknown>;
};

export function createBoundActionRegistry<Action extends string>(context: ActionBinding, actions: readonly Action[]) {
  type Entry = BoundActionHandler<Action> & { node: GraphNode; scope: string };
  const handlers = shallowReactive(new Map<string, Entry>());
  const running = shallowReactive(new Set<Entry>());
  const registrations = new Map<string, { stop?: () => void }>();
  let disposed = false;
  const owns = (node: GraphNode, entry: Entry) => !disposed && handlers.get(node.id) === entry
    && Boolean(entry.scope) && entry.scope === context.scope() && entry.node === node && context.findNode(node.id) === node;
  function current(node: GraphNode, action: Action) {
    const entry = handlers.get(node.id);
    return entry && owns(node, entry) && context.active() && actions.includes(action)
      && !running.has(entry) && entry.available(action) ? entry : undefined;
  }
  return {
    available: (node: GraphNode, action: Action) => Boolean(current(node, action)),
    candidates: (action: Action) => [...handlers.values()].flatMap(entry => current(entry.node, action) ? [entry.node] : []),
    register(node: GraphNode, handler: BoundActionHandler<Action>) {
      if (disposed) return () => {};
      registrations.get(node.id)?.stop?.();
      const registration: { stop?: () => void } = {};
      registrations.set(node.id, registration);
      handlers.delete(node.id);
      let entry: Entry | undefined;
      let awaitingBinding = true;
      registration.stop = watch(context.scope, scope => {
        if (disposed || registrations.get(node.id) !== registration) return;
        if (!scope) {
          if (handlers.get(node.id) === entry) handlers.delete(node.id);
          entry = undefined;
          awaitingBinding = true;
          return;
        }
        // applyCanvas publishes its binding after mounting the new graph.
        if (!awaitingBinding || context.findNode(node.id) !== node) return;
        awaitingBinding = false;
        entry = { ...handler, node, scope };
        handlers.set(node.id, entry);
      }, { immediate: true, flush: "sync" });
      return () => {
        registration.stop?.();
        if (registrations.get(node.id) === registration) registrations.delete(node.id);
        if (handlers.get(node.id) === entry) handlers.delete(node.id);
      };
    },
    async run(node: GraphNode, action: Action) {
      const entry = current(node, action);
      if (!entry) return false;
      running.add(entry);
      try {
        await entry.run(action, { assertCurrent: () => {
          if (!owns(node, entry) || !context.active()) throw new Error(translate("原节点已变化，请重新操作"));
        } });
        return owns(node, entry);
      } finally { running.delete(entry); }
    },
    dispose() {
      disposed = true;
      for (const registration of registrations.values()) registration.stop?.();
      registrations.clear(); handlers.clear(); running.clear();
    },
  };
}
