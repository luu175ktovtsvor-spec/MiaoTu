// `@miaoimg/model-icons` 的本地等价实现（见 components/modelIcon.vue）。
export { default as modelIcon } from "./components/modelIcon.vue";

export function getModelIcon(model: string) {
  return model ? { name: model } : undefined;
}
