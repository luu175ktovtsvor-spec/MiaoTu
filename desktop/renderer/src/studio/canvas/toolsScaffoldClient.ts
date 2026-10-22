// `@miaoimg/tools-scaffold/client` 的本地实现：妙图没有独立的工具前端包，
// 需要交互的工具（如 askUser 问答卡）在这里注册本地组件，其余工具走通用卡片渲染。
import { defineAsyncComponent, type Component } from 'vue'

const registry: Record<string, Component> = {
  askUser: defineAsyncComponent(() => import('./components/agent/questionCard.vue')),
}

export async function loadToolComponent(name: string): Promise<Component | undefined> {
  return registry[name]
}
