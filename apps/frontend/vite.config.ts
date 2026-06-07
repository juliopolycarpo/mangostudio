import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseRuntimeEnvFile } from '@mangostudio/shared/runtime-env';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { parse as parseToml } from 'smol-toml';
import { defineConfig } from 'vite';

interface MangoViteConfig {
  serverHost: string;
  serverPort: number;
  frontendPort: number;
}

type MangoTomlConfig = {
  server?: { host?: string; port?: number };
  frontend?: { port?: number };
};

/** Reads MangoStudio config from ~/.mango/config.toml with ~/.mango/.env overrides. */
function loadMangoConfig(): MangoViteConfig {
  const config = createMangoConfigDefaults();
  const mangoDir = path.join(homedir(), '.mango');

  applyTomlConfig(config, path.join(mangoDir, 'config.toml'));
  applyRuntimeEnvOverrides(config, path.join(mangoDir, '.env'));

  return config;
}

function createMangoConfigDefaults(): MangoViteConfig {
  return { serverHost: 'localhost', serverPort: 3001, frontendPort: 5173 };
}

function applyTomlConfig(config: MangoViteConfig, tomlPath: string): void {
  if (existsSync(tomlPath)) {
    try {
      applyParsedTomlConfig(config, parseToml(readFileSync(tomlPath, 'utf8')) as MangoTomlConfig);
    } catch {
      // Ignore parse errors — use defaults
    }
  }
}

function applyParsedTomlConfig(config: MangoViteConfig, parsed: MangoTomlConfig): void {
  if (parsed.server?.host) config.serverHost = parsed.server.host;
  if (parsed.server?.port) config.serverPort = parsed.server.port;
  if (parsed.frontend?.port) config.frontendPort = parsed.frontend.port;
}

function applyRuntimeEnvOverrides(config: MangoViteConfig, envPath: string): void {
  const envOverrides = parseRuntimeEnvFile(envPath);
  for (const [key, value] of Object.entries(envOverrides)) {
    applyRuntimeEnvOverride(config, key, value);
  }
}

function applyRuntimeEnvOverride(config: MangoViteConfig, key: string, value: string): void {
  if (key === 'API_PORT') config.serverPort = Number(value) || config.serverPort;
  if (key === 'API_HOST') config.serverHost = value;
  if (key === 'FRONTEND_PORT') config.frontendPort = Number(value) || config.frontendPort;
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
