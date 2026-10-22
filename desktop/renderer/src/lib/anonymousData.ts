// 妙图不做匿名使用数据上报：这里保留 MiaoImg 工作台需要的同形接口，实现全部为空。
export default {
  track(_event: string) {},
  startAgent() {
    return (_status?: string) => {}
  },
  observeCanvas(_read: () => unknown) {
    return (_status?: string) => {}
  },
}
