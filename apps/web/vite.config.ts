import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        // 'prompt' rather than 'autoUpdate': a silent reload in the middle of a
        // sale would lose the cart, so the user chooses when to update.
        registerType: 'prompt',
        includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'Pharmacy POS',
          short_name: 'Pharmacy',
          description: 'Point of sale and inventory for the pharmacy counter',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'any',
          background_color: '#ffffff',
          theme_color: '#0f766e',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: 'icons/icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // Precache the app shell only. API responses are never cached here;
          // offline billing data is handled separately (IndexedDB).
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      rollupOptions: {
        output: {
          // Libraries change far less often than app code; separate chunks
          // mean an app update does not re-download them.
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (/node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) {
              return 'react';
            }
            if (/node_modules[\\/]zod[\\/]/.test(id)) return 'zod';
            // Only the dashboard and reports draw charts; the counter never loads them.
            if (/node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor)[\\/]/.test(id)) {
              return 'charts';
            }
            return 'vendor';
          },
        },
      },
    },
    server: {
      port: 5173,
      // Same-origin in dev as in production (Nginx), so the SameSite=Strict
      // refresh cookie works and the API needs no CORS. xfwd passes the
      // browser's Host on (X-Forwarded-Host), which the API's origin check
      // compares with the Origin header, as it does behind Nginx.
      proxy: {
        '/api': {
          target: env.API_PROXY_TARGET || 'http://localhost:4000',
          changeOrigin: true,
          xfwd: true,
        },
      },
    },
  };
});
