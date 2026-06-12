import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  createDockerStagePlan,
  dockerReleaseAssetName,
  parseDockerArchFilter,
} from '../lib/docker-stage';
import { readText } from './support/read-text';

describe('Docker stage planning', () => {
  test('maps buildx TARGETARCH values to musl release outputs', () => {
    const plan = createDockerStagePlan({ rootDir: '/repo' });

    expect(
      plan.targets.map((target) => ({
        dockerArch: target.dockerArch,
        platform: target.platform.arch,
        binaryPath: target.binaryPath,
        stagedBinaryPath: target.stagedBinaryPath,
      }))
    ).toEqual([
      {
        dockerArch: 'amd64',
        platform: 'linux-x64-musl',
        binaryPath: join('/repo', '.mango', 'out', 'linux-x64-musl', 'mangostudio'),
        stagedBinaryPath: join('/repo', 'docker-ctx', 'amd64', 'mangostudio'),
      },
      {
        dockerArch: 'arm64',
        platform: 'linux-arm64-musl',
        binaryPath: join('/repo', '.mango', 'out', 'linux-arm64-musl', 'mangostudio'),
        stagedBinaryPath: join('/repo', 'docker-ctx', 'arm64', 'mangostudio'),
      },
    ]);
  });

  test('supports one-arch staging filters', () => {
    const plan = createDockerStagePlan({
      rootDir: '/repo',
      contextDir: '/tmp/docker-ctx',
      onlyArch: parseDockerArchFilter('amd64'),
    });

    expect(plan.contextDir).toBe('/tmp/docker-ctx');
    expect(plan.targets.map((target) => target.dockerArch)).toEqual(['amd64']);
    expect(parseDockerArchFilter('all')).toBeUndefined();
    expect(() => parseDockerArchFilter('x64')).toThrow(/Docker arch must be one of/);
  });

  test('resolves release asset names for staged Docker inputs', () => {
    expect(dockerReleaseAssetName('1.2.3', 'amd64')).toBe(
      'mangostudio-1.2.3-linux-x64-musl.tar.gz'
    );
    expect(dockerReleaseAssetName('1.2.3', 'arm64')).toBe(
      'mangostudio-1.2.3-linux-arm64-musl.tar.gz'
    );
  });
});

describe('Docker release wiring', () => {
  test('keeps the image context minimal and sourced from docker-ctx', () => {
    const dockerfile = readText('Dockerfile');
    const dockerignore = readText('.dockerignore');
    const targetArch = '$' + '{TARGETARCH}';

    expect(dockerfile).toContain('FROM alpine:3.21');
    expect(dockerfile).toContain('libstdc++');
    expect(dockerfile).toContain(`COPY docker-ctx/${targetArch}/mangostudio`);
    expect(dockerfile).toContain('org.opencontainers.image.source');
    expect(dockerignore).toContain('!docker-ctx/**');
  });

  test('publishes a multi-arch GHCR image during release', () => {
    const workflow = readText('.github/workflows/release.yml');
    const repoExpression = '$' + '{{ github.repository }}';
    const versionExpression = '$' + '{{ needs.build.outputs.version }}';

    expect(workflow).toContain('docker/build-push-action@v6');
    expect(workflow).toContain('docker/setup-qemu-action@v3');
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain(`ghcr.io/${repoExpression}:${versionExpression}`);
  });

  test('smoke workflow builds and runs the Docker image before PR merge', () => {
    const workflow = readText('.github/workflows/smoke-binary.yml');

    expect(workflow).toContain('stage-docker-ctx.ts --arch amd64');
    expect(workflow).toContain('docker build --platform linux/amd64');
    expect(workflow).toContain('docker run --rm -d');
    expect(workflow).toContain('/api/health');
    expect(workflow).toContain("grep -q '<html'");
  });
});
