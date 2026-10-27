import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { archiveImagesPlugin, blockPrivateArchive } from './scripts/archiveMiddleware.ts'

const WEB_DIR = fileURLToPath(new URL('.', import.meta.url))
const DIMS_FILE = resolve(WEB_DIR, 'dims.json')
const API_PORT = globalThis.process?.env.OIP_API_PORT || '8787'
const IMAGE_API_PORT = globalThis.process?.env.OIP_IMAGE_API_PORT || '8788'
const ADMIN_API_PORT = globalThis.process?.env.OIP_ADMIN_PORT || '4184'
const ARCHIVE_ENABLED = globalThis.process?.env.OIP_ENABLE_ARCHIVE !== 'false'

function apiProxy(port) {
  // Keep the browser Host. The login check compares it with Origin, and the
  // string form of Vite's proxy rewrites Host to the upstream port.
  return { target: `http://127.0.0.1:${port}`, changeOrigin: false }
}
const GALLERY_HMR_PORT = Number(globalThis.process?.env.OIP_GALLERY_HMR_PORT || 0)


function archiveAssetsPlugin() {
  return {
    name: 'miaoimg-assets',
    configureServer(server) {
      blockPrivateArchive(server.middlewares)
    },
    configurePreviewServer(server) {
      blockPrivateArchive(server.middlewares)
    },
    generateBundle() {
      try {
        this.emitFile({
          type: 'asset',
          fileName: 'dims.json',
          source: readFileSync(DIMS_FILE),
        })
      } catch {
        // dims.json is optional (run scripts/export_dims.py to regenerate)
      }
    },
  }
}

// The web Agent shares the reviewed showcase catalog with the desktop Agent.
// Keep the catalog and prompt shards as build assets so the API can search
// them without importing the renderer bundle or copying the full media set.
function showcaseAgentManifestPlugin() {
  const catalog = resolve(WEB_DIR, '../desktop/renderer/src/library/showcase.json')
  const promptDir = resolve(WEB_DIR, '../desktop/renderer/public/inspiration/prompts')
  const translationDir = resolve(WEB_DIR, '../desktop/renderer/public/inspiration/translations')
  return {
    name: 'miaoimg-showcase-agent-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'showcase-agent.json', source: readFileSync(catalog) })
      for (const [directory, prefix] of [[promptDir, 'inspiration/prompts'], [translationDir, 'inspiration/translations']] as const) {
        // Both directories are committed build inputs. A missing shard source
        // must fail the build instead of shipping a partially searchable catalog.
        for (const file of readdirSync(directory).sort()) {
          if (!file.endsWith('.json')) continue
          this.emitFile({ type: 'asset', fileName: `${prefix}/${file}`, source: readFileSync(resolve(directory, file)) })
        }
      }
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), archiveImagesPlugin(), archiveAssetsPlugin(), showcaseAgentManifestPlugin()],
  server: {
    // Never inherit Vite's dual-stack `localhost` default: it lets the dev
    // server bind [::1] while an unrelated process owns IPv4 on the same port,
    // and the printed localhost URL then opens that other application.
    // scripts/with_api.ts overrides this from OIP_WEB_HOST when set.
    host: '127.0.0.1',
    hmr: GALLERY_HMR_PORT
      ? { host: '127.0.0.1', clientPort: GALLERY_HMR_PORT }
      : undefined,
    proxy: {
      '/api/admin': apiProxy(ADMIN_API_PORT),
      '/api/imagine': apiProxy(IMAGE_API_PORT),
      '/api/agent': apiProxy(IMAGE_API_PORT),
      '/api/mcp': apiProxy(IMAGE_API_PORT),
      '/api/nodes': apiProxy(IMAGE_API_PORT),
      '/api/ext': apiProxy(IMAGE_API_PORT),
      '/api/plugins': apiProxy(IMAGE_API_PORT),
      '/api/ai': apiProxy(IMAGE_API_PORT),
      '/api/ffmpeg': apiProxy(IMAGE_API_PORT),
      '/mcp': apiProxy(IMAGE_API_PORT),
      '/api': apiProxy(API_PORT),
      '/health': apiProxy(ARCHIVE_ENABLED ? API_PORT : IMAGE_API_PORT),
    },
  },
  preview: {
    host: '127.0.0.1',
    proxy: {
      '/api/admin': apiProxy(ADMIN_API_PORT),
      '/api/imagine': apiProxy(IMAGE_API_PORT),
      '/api/agent': apiProxy(IMAGE_API_PORT),
      '/api/mcp': apiProxy(IMAGE_API_PORT),
      '/api/nodes': apiProxy(IMAGE_API_PORT),
      '/api/ext': apiProxy(IMAGE_API_PORT),
      '/api/plugins': apiProxy(IMAGE_API_PORT),
      '/api/ai': apiProxy(IMAGE_API_PORT),
      '/api/ffmpeg': apiProxy(IMAGE_API_PORT),
      '/mcp': apiProxy(IMAGE_API_PORT),
      '/api': apiProxy(API_PORT),
      '/health': apiProxy(ARCHIVE_ENABLED ? API_PORT : IMAGE_API_PORT),
    },
  },
  build: {
    outDir: 'dist',
  },
})
