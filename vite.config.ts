import { defineConfig } from 'vite';
import { offlinePlugin } from './scripts/offline-plugin.ts';
export default defineConfig({
  base: '/totp/',
  plugins: [offlinePlugin()],
});
