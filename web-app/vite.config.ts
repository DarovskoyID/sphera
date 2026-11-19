import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [
    react(),
  ],
  base: './',
  resolve: {
    alias: {
      // Public Module SDK; modules/<id>/frontend import only from here.
      '@sfera/sdk': fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/media': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
      '/tenor-api': {
        target: 'https://g.tenor.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tenor-api/, '/v1'),
      },
    },
  },
})
