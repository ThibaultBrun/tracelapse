import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Base is '/' for custom-domain / root hosting. Override with --base for GH Pages subpath.
export default defineConfig({
  plugins: [vue()],
  base: process.env.VITE_BASE ?? '/',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
})
