/**
 * Secret persistence — read and write API keys across all supported storage backends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProviderType, SecretSource } from '@mangostudio/shared/types';
import { stringify as stringifyToml } from 'smol-toml';
import { getConfig, getMangoDir, reloadSecretEnv } from '../../../lib/config';
import { readTomlStringSections } from '../../../lib/toml';
import { bunSecretStore } from '../../../services/secret-store/store';
import { PROVIDER_SECRET_CONFIG } from '../domain/connector';

/** Persists an API key in the storage backend selected by `source`. */
export async function persistSecret(
  id: string,
  name: string,
  provider: ProviderType,
  source: SecretSource,
  apiKey: string
): Promise<void> {
  const cfg = PROVIDER_SECRET_CONFIG[provider];

  switch (source) {
    case 'bun-secrets':
      await bunSecretStore.setSecret(
        { service: 'mangostudio', name: `${provider}-api-key:${id}` },
        apiKey
      );
      break;

    case 'config-file': {
      const configPath = getConfig().configFilePath;
      mkdirSync(dirname(configPath), { recursive: true });
      const config = readTomlStringSections(configPath);
      config[cfg.tomlSection] ??= {};
      config[cfg.tomlSection][name] = apiKey;
      writeFileSync(configPath, stringifyToml(config));
      break;
    }

    case 'environment': {
      const envPath = join(getMangoDir(), '.env');
      const envVar = `${cfg.envPrefix}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const currentContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
      writeFileSync(envPath, `${currentContent}\n${envVar}="${apiKey}"\n`);
      // Re-sync process.env from the file so the new key resolves immediately,
      // without forwarding it to detached children (the spawn allowlist withholds it).
      reloadSecretEnv();
      break;
    }
  }
}

/** Removes an API key from the storage backend. */
export async function removeSecret(
  id: string,
  name: string,
  provider: ProviderType,
  source: SecretSource
): Promise<void> {
  const cfg = PROVIDER_SECRET_CONFIG[provider];

  switch (source) {
    case 'bun-secrets':
      try {
        await bunSecretStore.deleteSecret({
          service: 'mangostudio',
          name: `${provider}-api-key:${id}`,
        });
      } catch {
        // Ignore — secret may already be gone
      }
      break;

    case 'config-file': {
      try {
        const configPath = getConfig().configFilePath;
        if (existsSync(configPath)) {
          const config = readTomlStringSections(configPath);
          const section = (config as Record<string, Record<string, string> | undefined>)[
            cfg.tomlSection
          ];
          if (section) {
            delete section[name];
            writeFileSync(configPath, stringifyToml(config));
          }
        }
      } catch (err) {
        console.error(`[connectors] Failed to remove key from config.toml:`, err);
      }
      break;
    }

    case 'environment': {
      try {
        const envPath = join(getMangoDir(), '.env');
        if (existsSync(envPath)) {
          const envVar = `${cfg.envPrefix}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
          const content = readFileSync(envPath, 'utf8');
          const lines = content.split('\n').filter((l) => !l.trim().startsWith(`${envVar}=`));
          writeFileSync(envPath, lines.join('\n'));
          // Re-sync process.env so the running server stops resolving the removed key.
          reloadSecretEnv();
        }
      } catch (err) {
        console.error(`[connectors] Failed to remove key from .env:`, err);
      }
      break;
    }
  }
}
