import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  createDockerStagePlan,
  dockerReleaseAssetName,
  parseDockerArchFilter,
  parseDockerVariantFilter,
} from '../lib/docker-stage';
import { readText } from './support/read-text';

describe('Docker stage planning', () => {
  test('maps image variants and buildx TARGETARCH values to release outputs', () => {
    const plan = createDockerStagePlan({ rootDir: '/repo' });

    expect(
      plan.targets.map((target) => ({
        dockerVariant: target.dockerVariant,
        dockerArch: target.dockerArch,
        platform: target.platform.arch,
        binaryPath: target.binaryPath,
        stagedBinaryPath: target.stagedBinaryPath,
      }))
    ).toEqual([
      {
        dockerVariant: 'bookworm',
        dockerArch: 'amd64',
        platform: 'linux-x64',
        binaryPath: join('/repo', '.mango', 'out', 'linux-x64', 'mangostudio'),
        stagedBinaryPath: join('/repo', 'docker-ctx', 'bookworm', 'amd64', 'mangostudio'),
      },
      {
        dockerVariant: 'bookworm',
        dockerArch: 'arm64',
        platform: 'linux-arm64',
        binaryPath: join('/repo', '.mango', 'out', 'linux-arm64', 'mangostudio'),
        stagedBinaryPath: join('/repo', 'docker-ctx', 'bookworm', 'arm64', 'mangostudio'),
      },
      {
        dockerVariant: 'alpine',
        dockerArch: 'amd64',
        platform: 'linux-x64-musl',
        binaryPath: join('/repo', '.mango', 'out', 'linux-x64-musl', 'mangostudio'),
        stagedBinaryPath: join('/repo', 'docker-ctx', 'alpine', 'amd64', 'mangostudio'),
      },
      {
        dockerVariant: 'alpine',
        dockerArch: 'arm64',
        platform: 'linux-arm64-musl',
        binaryPath: join('/repo', '.mango', 'out', 'linux-arm64-musl', 'mangostudio'),
        stagedBinaryPath: join('/repo', 'docker-ctx', 'alpine', 'arm64', 'mangostudio'),
      },
    ]);
  });

  test('supports one-arch and one-variant staging filters', () => {
    const plan = createDockerStagePlan({
      rootDir: '/repo',
      contextDir: '/tmp/docker-ctx',
      onlyArch: parseDockerArchFilter('amd64'),
      onlyVariant: parseDockerVariantFilter('alpine'),
    });

    expect(plan.contextDir).toBe('/tmp/docker-ctx');
    expect(plan.targets.map((target) => `${target.dockerVariant}/${target.dockerArch}`)).toEqual([
      'alpine/amd64',
    ]);
    expect(parseDockerArchFilter('all')).toBeUndefined();
    expect(parseDockerVariantFilter('all')).toBeUndefined();
    expect(() => parseDockerArchFilter('x64')).toThrow(/Docker arch must be one of/);
    expect(() => parseDockerVariantFilter('debian')).toThrow(/Docker variant must be one of/);
  });

  test('resolves release asset names for staged Docker inputs', () => {
    expect(dockerReleaseAssetName('1.2.3', 'bookworm', 'amd64')).toBe(
      'mangostudio-1.2.3-linux-x64.tar.gz'
    );
    expect(dockerReleaseAssetName('1.2.3', 'bookworm', 'arm64')).toBe(
      'mangostudio-1.2.3-linux-arm64.tar.gz'
    );
    expect(dockerReleaseAssetName('1.2.3', 'alpine', 'amd64')).toBe(
      'mangostudio-1.2.3-linux-x64-musl.tar.gz'
    );
    expect(dockerReleaseAssetName('1.2.3', 'alpine', 'arm64')).toBe(
      'mangostudio-1.2.3-linux-arm64-musl.tar.gz'
    );
  });
});

describe('Docker release wiring', () => {
  test('keeps the image context minimal and sourced from docker-ctx', () => {
    const dockerfile = readText('Dockerfile');
    const alpineDockerfile = readText('Dockerfile.alpine');
    const dockerignore = readText('.dockerignore');
    const targetArch = '$' + '{TARGETARCH}';

    expect(dockerfile).toContain('FROM debian:bookworm-slim');
    expect(dockerfile).toContain('libstdc++6');
    expect(dockerfile).toContain(`COPY docker-ctx/bookworm/${targetArch}/mangostudio`);
    expect(alpineDockerfile).toContain('FROM alpine:3.21');
    expect(alpineDockerfile).toContain('libstdc++');
    expect(alpineDockerfile).toContain(`COPY docker-ctx/alpine/${targetArch}/mangostudio`);
    expect(dockerfile).toContain('org.opencontainers.image.source');
    expect(dockerignore).toContain('!docker-ctx/**');
  });

  test('publishes multi-arch GHCR images during release', () => {
    const workflow = readText('.github/workflows/release.yml');
    const repoExpression = '$' + '{{ github.repository }}';
    const versionExpression = '$' + '{{ needs.build.outputs.version }}';

    expect(workflow).toContain('docker/build-push-action@v6');
    expect(workflow).toContain('docker/setup-qemu-action@v3');
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain(`ghcr.io/${repoExpression}:${versionExpression}`);
    expect(workflow).toContain(`ghcr.io/${repoExpression}:${versionExpression}-bookworm`);
    expect(workflow).toContain(`ghcr.io/${repoExpression}:${versionExpression}-alpine`);
    expect(workflow).toContain('file: Dockerfile.alpine');
  });

  test('smoke workflow builds and runs the Docker image variants before PR merge', () => {
    const workflow = readText('.github/workflows/smoke-binary.yml');

    expect(workflow).toContain('build:binary --platform linux-x64');
    expect(workflow).toContain('build:binary --platform linux-x64-musl');
    expect(workflow).toContain('stage-docker-ctx.ts --arch amd64');
    expect(workflow).toContain('docker build --platform linux/amd64');
    expect(workflow).toContain('Dockerfile.alpine');
    expect(workflow).toContain('docker run --rm -d');
    expect(workflow).toContain('/api/health');
    expect(workflow).toContain("grep -q '<html'");
  });
});
