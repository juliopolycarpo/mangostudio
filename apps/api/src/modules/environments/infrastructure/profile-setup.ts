import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstallProfileSetup } from '@mangostudio/shared/environments';

const PROFILE_FILENAMES = ['.bashrc', '.bash_profile', '.profile', '.zprofile', '.zshrc'] as const;

interface ProfileSetupInspectorDeps {
  readonly homeDirectory: string;
  readonly readFile: (path: string) => Promise<string>;
}

const defaultDeps: ProfileSetupInspectorDeps = {
  homeDirectory: homedir(),
  readFile: (path) => readFile(path, 'utf8'),
};

export type ProfileSetupInspector = (lines: readonly string[]) => Promise<InstallProfileSetup>;

export function createProfileSetupInspector(
  overrides: Partial<ProfileSetupInspectorDeps> = {}
): ProfileSetupInspector {
  const deps = { ...defaultDeps, ...overrides };

  return async (lines) => {
    const expectedLines = [...lines];
    const detectedIn: string[] = [];

    for (const filename of PROFILE_FILENAMES) {
      const path = join(deps.homeDirectory, filename);
      try {
        const content = await deps.readFile(path);
        const actualLines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
        if (expectedLines.every((line) => actualLines.has(line))) {
          detectedIn.push(path);
        }
      } catch {
        // Missing or unreadable profiles are simply not detected.
      }
    }

    return {
      lines: expectedLines,
      present: detectedIn.length > 0,
      detectedIn,
    };
  };
}

export const inspectProfileSetup = createProfileSetupInspector();
