// 兼容入口：vite 把 @miaoimg/i18n 和 @miaoimg/i18n/vue 都指到这里，
// 上游组件的 import 路径保持不变。真实现在 ./i18n/。
export * from './i18n/vue'
