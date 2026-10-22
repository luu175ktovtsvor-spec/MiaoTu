import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
export default defineConfig({
 base:'/admin-assets/', plugins:[react()],
 define:{'import.meta.env.VITE_ADMIN_API_BASE':JSON.stringify('/admin-api')},
 build:{outDir:'admin-dist',emptyOutDir:true,rollupOptions:{input:fileURLToPath(new URL('./admin.html',import.meta.url))}},
})
