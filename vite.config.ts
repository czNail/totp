import { defineConfig } from 'vite';
import { headerMarkup, footerMarkup } from './vendor/site-ui/shell.mjs';
import { offlinePlugin } from './scripts/offline-plugin.ts';
export default defineConfig({
  base: '/totp/',
  plugins: [{ name: 'shared-site-shell', transformIndexHtml: html => html.replace('<!-- site-ui:runtime -->', '<script src="/totp/site-ui/runtime.js"></script>').replace('<!-- site-ui:header -->', headerMarkup({ active: 'totp' })).replace('<!-- site-ui:footer -->', footerMarkup()) }, offlinePlugin()],
});
