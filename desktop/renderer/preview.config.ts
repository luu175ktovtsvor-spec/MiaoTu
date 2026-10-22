// Static renderer inspection uses no cloud providers or native API proxy.
import { defineConfig } from 'vite'
import { archiveImagesPlugin, blockPrivateArchive } from './scripts/archiveMiddleware.ts'
import { rendererOnlyPlugin } from './scripts/rendererOnly.ts'

export default defineConfig({
  base: './',
  plugins: [rendererOnlyPlugin(), archiveImagesPlugin(), { name: 'private-archive', configurePreviewServer(server) { blockPrivateArchive(server.middlewares) } }],
  preview: { host: '127.0.0.1' },
})
