import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { parse as parseToml } from 'smol-toml';
import { defineConfig } from 'vite';

/** Reads MangoStudio config from ~/.mango/config.toml with ~/.mango/.env overrides. */
function loadMangoConfig() {
  const defaults = { serverHost: 'localhost', serverPort: 3001, frontendPort: 5173 };
  const mangoDir = path.join(homedir(), '.mango');

  // Read config.toml
  const tomlPath = path.join(mangoDir, 'config.toml');
  if (existsSync(tomlPath)) {
    try {
      const parsed = parseToml(readFileSync(tomlPath, 'utf8')) as {
        server?: { host?: string; port?: number };
        frontend?: { port?: number };
      };
      if (parsed.server?.host) defaults.serverHost = parsed.server.host;
      if (parsed.server?.port) defaults.serverPort = parsed.server.port;
      if (parsed.frontend?.port) defaults.frontendPort = parsed.frontend.port;
    } catch {
      // Ignore parse errors — use defaults
    }
  }

  // Apply ~/.mango/.env overrides
  const envPath = path.join(mangoDir, '.env');
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key === 'API_PORT') defaults.serverPort = Number(value) || defaults.serverPort;
        if (key === 'API_HOST') defaults.serverHost = value;
        if (key === 'FRONTEND_PORT') defaults.frontendPort = Number(value) || defaults.frontendPort;
      }
    } catch {
      // Ignore read errors
    }
  }

  return defaults;
}

const mangoConfig = loadMangoConfig();
const apiTarget = `http://${mangoConfig.serverHost}:${mangoConfig.serverPort}`;

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    sourcemap: false,
    cssMinify: true,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom')) return 'vendor';
            if (id.includes('@tanstack/react-router') || id.includes('@tanstack/react-query'))
              return 'router';
            if (id.includes('motion') || id.includes('lucide-react')) return 'ui';
            if (id.includes('marked')) return 'markdown-parser';
            if (
              id.includes('@shikijs/core') ||
              id.includes('@shikijs/engine-javascript') ||
              id.includes('@shikijs/primitive') ||
              id.includes('@shikijs/types') ||
              id.includes('@shikijs/vscode-textmate') ||
              id.includes('hast-util-to-html')
            ) {
              return 'syntax-core';
            }
            if (id.includes('@shikijs/themes')) return 'syntax-themes';
            if (id.includes('@shikijs/langs')) return;
            if (id.includes('@tanstack/react-virtual')) return 'virtual';
            return 'vendor-deps';
          }
        },
      },
    },
  },
  server: {
    port: mangoConfig.frontendPort,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // Safety-net timeout for the proxy socket. The backend sends SSE
        // keepalive comments every 15s, so this should never fire in practice.
        timeout: 120_000,
      },
      '/uploads': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/images': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
