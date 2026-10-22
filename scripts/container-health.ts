// 容器健康检查：探 web 端口，外加部署时显式指定的内层 API 端口。
//
// 为什么不能只探 4173：web 进程（vite preview）活着、内层 API 进程崩掉时，只探 web 端口
// 会让 docker 和发布脚本**双双误判为健康**。2026-10-06 真发生过一次：镜像里缺 Agent SDK，
// API 进程在 import 阶段就退出、容器反复重启，但健康检查一直说健康，于是发布脚本以为发布成功、
// 没有回滚，nginx 对外 502。
//
// 内层端口用环境变量取（部署脚本会显式指定 OIP_IMAGE_API_PORT / OIP_API_PORT / OIP_ADMIN_PORT）。
// 没指定时（例如本机随手 docker run）只探 web 端口，保持原来的行为，避免误报不健康。
const ports = new Set([4173])
for (const name of ['OIP_IMAGE_API_PORT', 'OIP_API_PORT', 'OIP_ADMIN_PORT']) {
  const value = Number(process.env[name])
  if (Number.isInteger(value) && value > 0 && value < 65536) ports.add(value)
}

const results = await Promise.all([...ports].map(async (port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
    return { port, ok: response.ok }
  } catch {
    return { port, ok: false }
  }
}))

const failed = results.filter((item) => !item.ok)
if (failed.length) {
  console.error(`健康检查失败：${failed.map((item) => item.port).join(', ')} 端口不通（通过：${results.filter((i) => i.ok).map((i) => i.port).join(', ') || '无'}）`)
  process.exit(1)
}
process.exit(0)
