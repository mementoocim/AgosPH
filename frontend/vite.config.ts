import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        ...['Workers', 'ThirdParty', 'Assets', 'Widgets'].map((dir) => ({
          src: `../node_modules/cesium/Build/Cesium/${dir}`,
          dest: 'cesium',
        })),
        // MapLibre loads its worker by URL. Vite's dependency optimizer cannot serve it and the
        // build never emits it, so it is copied as-is like Cesium's workers (see GeoMap.tsx).
        { src: '../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', dest: 'maplibre' },
      ],
    }),
  ],
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium') },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.AGOS_BACKEND_URL || 'http://127.0.0.1:8000', ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      output: {
        manualChunks: { cesium: ['cesium'], charts: ['echarts'], maplibre: ['maplibre-gl'] },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
