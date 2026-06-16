/**
 * Secret persistence — read and write API keys across all supported storage backends.
 */

import type { ProviderType, SecretSource } from '@mangostudio/shared/types';
import { stringify as stringifyToml } from 'smol-toml';
import { getConfig, getConfigEnvFilePath, reloadSecretEnv } from '../../../lib/config';
import { readUtf8FileOrNull, SECRET_FILE_MODE, writeFileAtomic } from '../../../lib/safe-file';
import { deleteTomlSectionValue, readTomlDocument, setTomlSectionValue } from '../../../lib/toml';
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
      const config = readTomlDocument(configPath);
      setTomlSectionValue(config, cfg.tomlSection, name, apiKey);
      writeFileAtomic(configPath, stringifyToml(config), { mode: SECRET_FILE_MODE });
      break;
    }

    case 'environment': {
      const envPath = getConfigEnvFilePath(getConfig().configFilePath);
      const envVar = `${cfg.envPrefix}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const currentContent = readUtf8FileOrNull(envPath) ?? '';
      writeFileAtomic(envPath, `${currentContent}\n${envVar}="${apiKey}"\n`, {
        mode: SECRET_FILE_MODE,
      });
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
        const config = readTomlDocument(configPath);
        if (deleteTomlSectionValue(config, cfg.tomlSection, name)) {
          writeFileAtomic(configPath, stringifyToml(config), { mode: SECRET_FILE_MODE });
        }
      } catch (err) {
        console.error(`[connectors] Failed to remove key from config.toml:`, err);
      }
      break;
    }

    case 'environment': {
      try {
        const envPath = getConfigEnvFilePath(getConfig().configFilePath);
        const content = readUtf8FileOrNull(envPath);
        if (content !== null) {
          const envVar = `${cfg.envPrefix}_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
          const lines = content.split('\n').filter((l) => !l.trim().startsWith(`${envVar}=`));
          writeFileAtomic(envPath, lines.join('\n'), { mode: SECRET_FILE_MODE });
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
