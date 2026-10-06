import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Builds the desktop app's interface. Tauri serves `dist/` in the packaged app and
// loads the dev server (fixed port) during `npm run desktop:dev`.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: ['es2021', 'chrome105', 'safari15'], sourcemap: false },
});
