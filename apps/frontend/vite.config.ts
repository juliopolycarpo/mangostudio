import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { defineConfig } from 'vite';
import { parse as parseToml } from 'smol-toml';

/** Reads MangoStudio config from .mango/config.toml with .mango/.env overrides. */
function loadMangoConfig() {
  const defaults = { serverHost: 'localhost', serverPort: 3001, frontendPort: 5173 };

  // Read config.toml
  const tomlPath = path.resolve(__dirname, '../../.mango/config.toml');
  if (existsSync(tomlPath)) {
    try {
      const parsed = parseToml(readFileSync(tomlPath, 'utf8')) as Record<string, any>;
      if (parsed.server?.host) defaults.serverHost = parsed.server.host;
      if (parsed.server?.port) defaults.serverPort = parsed.server.port;
      if (parsed.frontend?.port) defaults.frontendPort = parsed.frontend.port;
    } catch {
      // Ignore parse errors — use defaults
    }
  }

  // Apply .mango/.env overrides
  const envPath = path.resolve(__dirname, '../../.mango/.env');
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
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
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
  server: {
    port: mangoConfig.frontendPort,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/uploads': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify(apiTarget),
  },
});
