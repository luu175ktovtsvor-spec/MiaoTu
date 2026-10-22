let epoch: Promise<string> | undefined

// Preload resolves this once per document. Components and transport reconnects
// keep the same epoch; only a native committed navigation creates a new one.
export function desktopDocumentEpoch(): Promise<string | undefined> {
  const native = window.miaoDesktop
  if (!native?.getDocumentEpoch) return Promise.resolve(undefined)
  return epoch ??= native.getDocumentEpoch().then(value => {
    if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('工作区页面初始化失败，请重新打开')
    return value
  })
}
