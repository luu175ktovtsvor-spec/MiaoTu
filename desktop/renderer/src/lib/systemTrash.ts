// 删除的东西会进系统自带的废纸篓；Windows 上叫回收站。
export const systemTrashName = () => /Mac/i.test(navigator.userAgent) ? '废纸篓' : '回收站'
