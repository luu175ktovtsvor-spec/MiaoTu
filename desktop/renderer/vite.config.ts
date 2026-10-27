import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import vue from '@vitejs/plugin-vue'
import components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import tailwindcss from '@tailwindcss/vite'
import { archiveImagesPlugin, blockPrivateArchive } from './scripts/archiveMiddleware.ts'
import { rendererOnlyPlugin } from './scripts/rendererOnly.ts'

const WEB_DIR = fileURLToPath(new URL('.', import.meta.url))
const DIMS_FILE = resolve(WEB_DIR, 'dims.json')
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

// The desktop Agent runs beside the renderer and needs the same reviewed film
// catalog that the "视频精选" tab displays. Keep one source of truth in
// src/library/showcase.json, then expose a small runtime-readable copy in the
// renderer build without embedding prompt bodies a second time.
function showcaseAgentManifestPlugin() {
  return {
    name: 'miaoimg-showcase-agent-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'showcase-agent.json',
        source: readFileSync(resolve(WEB_DIR, 'src/library/showcase.json')),
      })
    },
  }
}

const studioDir = resolve(WEB_DIR, 'src/studio/canvas')
const scaffoldDir = resolve(studioDir, 'scaffold')

export default defineConfig({
  base: './',
  plugins: [react(), vue(), components({ resolvers: [ElementPlusResolver(), (name) => name.startsWith('Icon') ? { name, from: '@tabler/icons-vue' } : undefined] }), tailwindcss(), rendererOnlyPlugin(), archiveImagesPlugin(), archiveAssetsPlugin(), showcaseAgentManifestPlugin()],
  resolve: {
    dedupe: ["zod", "micromark", "micromark-util-decode-string", "htmlparser2", "marked"],
    alias: [
      { find: /^@miaoimg\/nodes-scaffold\/runtime$/, replacement: resolve(scaffoldDir, 'runtime.ts') },
      { find: /^@miaoimg\/nodes-scaffold\/nodeSkeleton$/, replacement: resolve(scaffoldDir, 'nodeSkeleton.vue') },
      { find: /^@miaoimg\/nodes-scaffold\/nodeDocument$/, replacement: resolve(scaffoldDir, 'nodeDocument.ts') },
      { find: /^@miaoimg\/nodes-scaffold\/nodeEvent$/, replacement: resolve(scaffoldDir, 'nodeEvent.ts') },
      { find: /^@miaoimg\/nodes-scaffold\/nodeTools$/, replacement: resolve(scaffoldDir, 'nodeTools.ts') },
      { find: /^@miaoimg\/nodes-scaffold\/nodeAi$/, replacement: resolve(scaffoldDir, 'nodeAi.ts') },
      { find: /^@miaoimg\/nodes-scaffold\/nodeInputs$/, replacement: resolve(scaffoldDir, 'nodeInputs.ts') },
      { find: /^@miaoimg\/nodes-scaffold\/connection$/, replacement: resolve(scaffoldDir, 'connection.ts') },
      { find: /^@miaoimg\/nodes-scaffold\/values$/, replacement: resolve(scaffoldDir, 'values.ts') },
      { find: /^@miaoimg\/nodes-scaffold\/workspaceFiles$/, replacement: resolve(scaffoldDir, 'workspaceFiles.ts') },
      { find: /^@miaoimg\/ffmpeg\/browser$/, replacement: resolve(scaffoldDir, 'browserFfmpeg.ts') },
      { find: /^@miaoimg\/nodes-scaffold\/promptInput$/, replacement: resolve(scaffoldDir, 'components/promptInput.vue') },
      { find: /^@miaoimg\/nodes-scaffold\/videoPlayer$/, replacement: resolve(scaffoldDir, 'components/videoPlayer.vue') },
      { find: /^@miaoimg\/nodes-scaffold\/mediaHistory$/, replacement: resolve(scaffoldDir, 'components/mediaHistory.vue') },
      { find: /^@miaoimg\/nodes-scaffold\/referenceItem$/, replacement: resolve(scaffoldDir, 'components/referenceItem.vue') },
      { find: /^@miaoimg\/nodes-scaffold\/imageEditor$/, replacement: resolve(scaffoldDir, 'components/imageEditor.vue') },
      { find: /^@miaoimg\/nodes-scaffold\/imageInpaintPrompt$/, replacement: resolve(scaffoldDir, 'components/imageInpaintPrompt.vue') },
      { find: /^@miaoimg\/nodes-scaffold\/imageGridSplit$/, replacement: resolve(scaffoldDir, 'components/imageGridSplit.vue') },
      { find: /^@miaoimg\/nodes-scaffold\/generationProgress$/, replacement: resolve(scaffoldDir, 'components/generationProgress.vue') },
      { find: /^@miaoimg\/tool-canvas\/runtime$/, replacement: resolve(studioDir, 'toolRuntimeCompat.ts') },
      { find: /^@miaoimg\/tools-scaffold\/runtime$/, replacement: resolve(studioDir, 'toolRuntimeCompat.ts') },
      { find: /^@miaoimg\/tools-scaffold\/client$/, replacement: resolve(studioDir, 'toolsScaffoldClient.ts') },
      { find: /^@miaoimg\/server\/agent\/types$/, replacement: resolve(studioDir, 'agentEvents.ts') },
      { find: /^@miaoimg\/server\/agent\/mentionSources$/, replacement: resolve(studioDir, 'mentionSources.ts') },
      { find: /^@miaoimg\/model-icons$/, replacement: resolve(studioDir, 'modelIcons.ts') },
      { find: /^@miaoimg\/assets\/logo\.svg$/, replacement: resolve(WEB_DIR, 'public/miaoimg-logo.png') },
      { find: /^@miaoimg\/i18n$/, replacement: resolve(studioDir, 'i18nCompat.ts') },
      { find: /^@miaoimg\/i18n\/vue$/, replacement: resolve(studioDir, 'i18nCompat.ts') },
      { find: '@', replacement: WEB_DIR + 'src' },
    ],
  },
  server: {
    // Never inherit Vite's dual-stack `localhost` default: it lets the dev
    // server bind [::1] while an unrelated process owns IPv4 on the same port,
    // and the printed localhost URL then opens that other application.
    host: '127.0.0.1',
    hmr: GALLERY_HMR_PORT
      ? { host: '127.0.0.1', clientPort: GALLERY_HMR_PORT }
      : undefined,
  },
  preview: {
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
  },
})
