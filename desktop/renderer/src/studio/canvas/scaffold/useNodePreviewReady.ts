import { canvasInjectionKey } from '../../../../../../server/canvas-document.ts'
import { inject, provide, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";
import { useNode, useNodeId, useVueFlow } from "@vue-flow/core";
import type { NodeDocumentContext } from "./nodeDocument";

const previewObserverKey = canvasInjectionKey("miaoimg.nodePreviewObserver");
type PreviewObserver = { observer: IntersectionObserver; targets: Map<Element, Set<Ref<boolean>>> };

const previewVisibilityKey=Symbol('nodePreviewVisibility');
/** A visible workbench or overlay may render media while its canvas card is offscreen. */
export function provideNodePreviewVisibility(visible:MaybeRefOrGetter<boolean>){provide(previewVisibilityKey,visible);}

export function useNodePreviewReady() {
  const nodeId = useNodeId();
  const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
  const ready = ref(!nodeId || typeof IntersectionObserver === "undefined");
  const visible=inject<MaybeRefOrGetter<boolean>|undefined>(previewVisibilityKey,undefined);
  if(visible!==undefined)watch(()=>toValue(visible),value=>{if(value)ready.value=true;},{immediate:true,flush:'sync'});
  if (ready.value) return ready;
  // 节点界面被投射到文档面板时，画布里的 IntersectionObserver 不会触发，直接视为就绪。
  watch(() => documentContext?.targets.has(nodeId), visible => {
    if (visible) ready.value = true;
  }, { immediate: true, flush: "sync" });
  const { nodeEl, node } = useNode();
  const { viewport } = useVueFlow();
  const host = globalThis as typeof globalThis & { [previewObserverKey]?: PreviewObserver };
  if (!host[previewObserverKey]) {
    const targets: PreviewObserver["targets"] = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        targets.get(entry.target)?.forEach(value => { value.value = true; });
        targets.delete(entry.target);
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "240px" });
    host[previewObserverKey] = { observer, targets };
  }
  const { observer, targets } = host[previewObserverKey];
  // ACT: 首次靠近视口才挂载预览，之后保留尺寸、播放器及插件 UI 状态；不卸载节点运行时。
  watch([nodeEl, ready], ([element], _previous, onCleanup) => {
    if (!element || ready.value) return;
    // 恢复画布时节点已经在视口内，直接挂载；否则等 IntersectionObserver 回调。
    // 只依赖 observe() 的首帧回调时，恢复后的节点可能一直停在"未挂载"状态。
    const rect = element.getBoundingClientRect();
    const margin = 240;
    if (rect.width > 0 && rect.height > 0 && rect.bottom > -margin && rect.top < (window.innerHeight || 0) + margin
      && rect.right > -margin && rect.left < (window.innerWidth || 0) + margin) {
      ready.value = true;
      return;
    }
    const subscribers = targets.get(element) ?? new Set<Ref<boolean>>();
    subscribers.add(ready);
    targets.set(element, subscribers);
    observer.observe(element);
    onCleanup(() => {
      subscribers.delete(ready);
      if (targets.get(element) === subscribers && !subscribers.size) {
        targets.delete(element);
        observer.unobserve(element);
      }
    });
  }, { immediate: true, flush: "post" });
  // 缩放、平移和选中时再核对实际矩形，不能只靠首次 observe 回调。
  watch(() => [viewport.value.x, viewport.value.y, viewport.value.zoom, node.selected], () => {
    if (ready.value) return;
    const element = nodeEl.value;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (node.selected || (rect.width > 0 && rect.height > 0 && rect.bottom > -240
      && rect.top < window.innerHeight + 240 && rect.right > -240 && rect.left < window.innerWidth + 240)) ready.value = true;
  }, { flush: "post" });
  return ready;
}
