import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertRustCostEnvironment, inspectRustCostCargoConfigs } from '../lib/rust-cost-inputs';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class CargoConfigFixture {
  readonly root: string;
  readonly home: string;
  readonly parentConfig: string;
  constructor(readonly directory: string) {
    this.root = join(directory, 'parent/workspace');
    this.home = join(directory, 'cargo-home');
    this.parentConfig = join(directory, 'parent/.cargo/config.toml');
  }
  async write(path: string, content: string): Promise<void> {
    await Bun.write(path, content);
  }
  inspect(
    tracked: readonly string[] = ['.cargo/config.toml']
  ): Promise<Record<string, string | null>> {
    return inspectRustCostCargoConfigs(this.root, { CARGO_HOME: this.home }, tracked);
  }
}

async function fixture(): Promise<CargoConfigFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'rust-cost-config-'));
  scratch.push(directory);
  const result = new CargoConfigFixture(directory);
  await mkdir(result.root, { recursive: true });
  return result;
}

describe('Rust cost environment admission', () => {
  test.each([
    'RUSTC',
    'RUSTC_WRAPPER',
    'RUSTC_WORKSPACE_WRAPPER',
    'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS',
    'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS',
    'CARGO_PROFILE_RELEASE_LTO',
    'CARGO_BUILD_RUSTC',
    'CARGO_BUILD_RUSTC_WRAPPER',
    'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',
    'CARGO_INCREMENTAL',
    'CARGO_BUILD_INCREMENTAL',
    'CARGO_BUILD_BUILD_DIR',
    'CARGO_BUILD_JOBS',
    'CARGO_CACHE_RUSTC_INFO',
    'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER',
  ])('rejects the inherited %s selector by name without exposing its value', (name) => {
    expect(() => assertRustCostEnvironment({ [name]: 'PRIVATE_SELECTOR_VALUE' })).toThrow(
      `received override names: ${name}`
    );
    try {
      assertRustCostEnvironment({ [name]: 'PRIVATE_SELECTOR_VALUE' });
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_SELECTOR_VALUE');
    }
  });
  test('admits ordinary registry settings and empty selectors', () => {
    expect(() =>
      assertRustCostEnvironment({
        CARGO_HOME: '/cargo',
        CARGO_NET_OFFLINE: 'true',
        CARGO_BUILD_RUSTC: '',
      })
    ).not.toThrow();
  });
});

describe('Rust cost Cargo configuration admission and seal', () => {
  test('seals ancestor creation, content changes, removal and Cargo-home slots', async () => {
    const files = await fixture();
    const before = await files.inspect();
    expect(before[files.parentConfig]).toBeNull();
    await files.write(files.parentConfig, '[net]\noffline = true\n');
    const created = await files.inspect();
    expect(created[files.parentConfig]).toMatch(/^[a-f0-9]{64}$/);
    expect(created).not.toEqual(before);
    await files.write(files.parentConfig, '[net]\noffline = false\n');
    expect(await files.inspect()).not.toEqual(created);
    await rm(files.parentConfig);
    expect(await files.inspect()).toEqual(before);
    const homeConfig = join(files.home, 'config');
    await files.write(homeConfig, '[registry]\ndefault = "crates-io"\n');
    expect((await files.inspect())[homeConfig]).toMatch(/^[a-f0-9]{64}$/);
  });
  test('uses extensionless filename precedence while sealing a shadowed TOML file', async () => {
    const files = await fixture();
    const directory = join(files.home, 'config');
    await files.write(directory, '[net]\noffline = true\n');
    const shadowed = join(files.home, 'config.toml');
    await files.write(shadowed, 'include = "unread.toml"\n');
    const before = await files.inspect();
    await files.write(shadowed, 'include = "changed.toml"\n');
    expect(await files.inspect()).not.toEqual(before);
    await rm(directory);
    await expect(files.inspect()).rejects.toThrow('received: include');
  });
  test.each(['root', 'ancestor', 'home'])(
    'refuses includes at %s before an included file can escape the seal',
    async (location) => {
      const files = await fixture();
      const path =
        location === 'root'
          ? join(files.root, '.cargo/config.toml')
          : location === 'ancestor'
            ? files.parentConfig
            : join(files.home, 'config.toml');
      await files.write(path, 'include = ["included.toml"]\n');
      const child = join(files.directory, 'included.toml');
      await files.write(child, '[build]\nrustc = "first-compiler"\n');
      await expect(files.inspect()).rejects.toThrow('received: include');
      await files.write(child, '[build]\nrustc = "second-compiler"\n');
      await expect(files.inspect()).rejects.toThrow('received: include');
    }
  );
  test.each([
    'rustc',
    'rustc-wrapper',
    'rustc-workspace-wrapper',
    'build-dir',
    'target-dir',
    'incremental',
    'target',
  ])('rejects tracked build.%s overrides', async (selector) => {
    const files = await fixture();
    await files.write(
      join(files.root, '.cargo/config.toml'),
      `[build]\n${selector} = "unsupported"\n`
    );
    await expect(files.inspect()).rejects.toThrow(`received: build.${selector}`);
  });
  test.each(['build', 'target', 'profile', 'env', 'paths', 'source', 'alias', 'unstable'])(
    'refuses external %s inputs',
    async (table) => {
      const files = await fixture();
      await files.write(files.parentConfig, `[${table}]\nselector = "unsupported"\n`);
      await expect(files.inspect()).rejects.toThrow(`received: ${table}`);
    }
  );
  test.each(['env', 'profile', 'paths', 'source', 'unstable'])(
    'also refuses tracked %s inputs that bypass driver admission',
    async (table) => {
      const files = await fixture();
      await files.write(
        join(files.root, '.cargo/config.toml'),
        `[${table}]\nselector = "unsupported"\n`
      );
      await expect(files.inspect()).rejects.toThrow(`received: ${table}`);
    }
  );
  test('admits tracked target flags and seals benign external registry/network tables', async () => {
    const files = await fixture();
    await files.write(
      join(files.root, '.cargo/config.toml'),
      '[target.\'cfg(windows)\']\nrustflags = ["-C", "target-feature=+crt-static"]\n'
    );
    await files.write(
      files.parentConfig,
      '[registries.internal]\nindex = "sparse+https://registry.example/"\n[http]\nproxy = "https://proxy.example"\n[credential-alias]\ncustom = ["provider"]\n'
    );
    const result = await files.inspect();
    expect(result[join(files.root, '.cargo/config.toml')]).toMatch(/^[a-f0-9]{64}$/);
    await expect(files.inspect([])).rejects.toThrow('received: target');
  });
  test('records only hashes for credential configuration and names only rejected selectors', async () => {
    const files = await fixture();
    await files.write(
      join(files.home, 'config.toml'),
      '[http]\nproxy = "https://user:CREDENTIAL_SECRET@proxy.example/"\n[registries.private]\ntoken = "TOKEN_SECRET"\n'
    );
    expect(JSON.stringify(await files.inspect())).not.toMatch(
      /CREDENTIAL_SECRET|TOKEN_SECRET|proxy.example/
    );
    await files.write(files.parentConfig, '[build]\nrustc = "COMPILER_PATH_SECRET"\n');
    const pending = files.inspect();
    await expect(pending).rejects.toThrow('received: build');
    try {
      await pending;
    } catch (error) {
      expect(String(error)).not.toContain('COMPILER_PATH_SECRET');
    }
  });
  test('resolves relative Cargo home from the driver root and deduplicates overlapping slots', async () => {
    const files = await fixture();
    const config = join(files.root, '.cargo/config.toml');
    await files.write(config, '[net]\noffline = true\n');
    const result = await inspectRustCostCargoConfigs(files.root, { CARGO_HOME: '.cargo' }, [
      '.cargo/config.toml',
    ]);
    expect(result[config]).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(result).filter((path) => path === config)).toHaveLength(1);
  });
  test('refuses an unreadable configuration slot instead of treating it as absent', async () => {
    const files = await fixture();
    await mkdir(files.parentConfig, { recursive: true });
    await expect(files.inspect()).rejects.toThrow(
      `Rust baseline Cargo config ${files.parentConfig}: expected readable file or absent slot | received: EISDIR`
    );
  });
  test('refuses invalid TOML with its path and expected shape', async () => {
    const files = await fixture();
    await files.write(files.parentConfig, '[http]\nproxy = "MALFORMED_CREDENTIAL_SECRET');
    const pending = files.inspect();
    await expect(pending).rejects.toThrow(
      `Rust baseline Cargo config ${files.parentConfig}: expected valid TOML`
    );
    try {
      await pending;
    } catch (error) {
      expect(String(error)).not.toContain('MALFORMED_CREDENTIAL_SECRET');
    }
  });
});
