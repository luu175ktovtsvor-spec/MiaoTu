import { createServer as createViteServer, preview } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Vite installs its own process-exit listeners. Keep them in a web-only process
// so they cannot end an API's accepted recovery or accounting work.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] === 'preview' ? 'preview' : 'dev'
const host = process.env.OIP_WEB_HOST?.trim() || '127.0.0.1'
const port = process.env.OIP_WEB_PORT ? Number(process.env.OIP_WEB_PORT) : undefined
try {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) throw new Error('Web service port is invalid')
  const endpoint = { host, ...(port ? { port, strictPort: true } : {}) }
  const server = mode === 'preview'
    ? await preview({ root: webRoot, configFile: resolve(webRoot, 'preview.config.ts'), preview: endpoint })
    : await (async () => {
        const dev = await createViteServer({ root: webRoot, server: endpoint })
        await dev.listen()
        return dev
      })()
  server.printUrls()
  if (process.send) await new Promise<void>((resolve, reject) => {
    process.send!({ type: 'miaoimg-vite-ready' }, error => error ? reject(error) : resolve())
  })
  if (process.connected) process.disconnect()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Web service failed to start')
  // This process contains only Vite, never an account/task database or API.
  // A partial Vite constructor can own watchers even if it did not return.
  process.exit(1)
}
