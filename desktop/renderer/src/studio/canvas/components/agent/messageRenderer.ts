import { defineAsyncComponent, defineComponent, h } from "vue";

// 先显示已经收到的文字；格式组件下载慢或失败时也不能把真实消息藏成空白。
const plainMessage = defineComponent({
  props: { content: { type: String, default: "" } },
  setup: props => () => h("div", {
    class: "messageMarkdown",
    style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  }, props.content),
});
let renderer: ReturnType<typeof importRenderer> | undefined;
const importRenderer = () => import("../messageMarkdown.vue");
function loadRenderer() {
  return renderer ??= importRenderer().catch(error => { renderer = undefined; throw error; });
}
export function warmMessageRenderer() {
  void loadRenderer().catch(() => { /* 保留文字回退，下一次打开可重新加载。 */ });
}
export const messageMarkdown = defineAsyncComponent({
  loader: loadRenderer,
  loadingComponent: plainMessage,
  errorComponent: plainMessage,
  delay: 0,
});
