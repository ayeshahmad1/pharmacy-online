import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so unit tests skip the PWA and Tailwind plugins.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
