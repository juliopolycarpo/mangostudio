import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDockerStagePlan,
  dockerReleaseAssetName,
  parseDockerArchFilter,
  parseDockerVariantFilter,
} from '../lib/docker-stage';
import { assertSafeToDelete } from '../lib/fs-assert';
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

  test('guards context-dir deletes to workspace and temp descendants', () => {
    const plan = createDockerStagePlan({ rootDir: '/repo' });
    const guard = {
      rootDir: '/repo',
      allowedOutsideRoots: [tmpdir()],
      label: 'Docker context',
    };

    expect(() => assertSafeToDelete(plan.contextDir, guard)).not.toThrow();
    expect(() => assertSafeToDelete(join(tmpdir(), 'docker-ctx'), guard)).not.toThrow();
    expect(() => assertSafeToDelete('/', guard)).toThrow(
      /Refusing to remove Docker context outside the workspace/
    );
    expect(() => assertSafeToDelete('/repo', guard)).toThrow(
      /Refusing to remove Docker context outside the workspace/
    );
    expect(() => assertSafeToDelete('/outside', guard)).toThrow(
      /Refusing to remove Docker context outside the workspace/
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
    const imageVar = '$' + '{IMAGE}';
    const versionVar = '$' + '{VERSION}';

    // Scripted, retry-wrapped buildx (not build-push-action) so each multi-arch
    // push can be retried on a transient GHCR failure.
    expect(workflow).not.toContain('docker/build-push-action');
    expect(workflow).toContain(
      'docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130 # v3.7.0'
    );
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('--platform linux/amd64,linux/arm64');
    // The image and version flow through env; tags are built from them.
    expect(workflow).toContain(`IMAGE: ghcr.io/${repoExpression}`);
    expect(workflow).toContain(`VERSION: ${versionExpression}`);
    expect(workflow).toContain(`--tag "${imageVar}:${versionVar}"`);
    expect(workflow).toContain(`--tag "${imageVar}:${versionVar}-bookworm"`);
    expect(workflow).toContain(`--tag "${imageVar}:latest"`);
    expect(workflow).toContain(`--tag "${imageVar}:${versionVar}-alpine"`);
    expect(workflow).toContain('--file Dockerfile.alpine');
  });

  test('release verifies the published multi-arch GHCR images', () => {
    const workflow = readText('.github/workflows/release.yml');
    const repoExpression = '$' + '{{ github.repository }}';
    const versionExpression = '$' + '{{ needs.build.outputs.version }}';

    expect(workflow).toContain('verify-image:');
    expect(workflow).toContain('needs: [build, docker]');
    expect(workflow).toContain('packages: read');
    expect(workflow).toContain('arch: amd64');
    expect(workflow).toContain('arch: arm64');
    expect(workflow).toContain('variant: bookworm');
    expect(workflow).toContain('variant: alpine');
    expect(workflow).toContain(`IMAGE: ghcr.io/${repoExpression}:${versionExpression}`);
    expect(workflow).toContain('tag_suffix: "-alpine"');
    expect(workflow).toContain('docker pull --platform "$PLATFORM" "$IMAGE"');
    expect(workflow).toContain('scripts/release/smoke-docker-image.sh "$IMAGE" "$PLATFORM"');
  });

  test('smoke workflow builds and runs the Docker image variants before PR merge', () => {
    const workflow = readText('.github/workflows/smoke-binary.yml');
    const smokeHelper = readText('scripts/release/smoke-docker-image.sh');
    const dockerArchExpression = '$' + '{{ matrix.docker_arch }}';
    const binaryPlatformExpression = '$' + '{{ matrix.binary_platform }}';

    expect(workflow).toContain('binary_platform: linux-x64');
    expect(workflow).toContain('binary_platform: linux-x64-musl');
    expect(workflow).toContain('binary_platform: linux-arm64');
    expect(workflow).toContain('binary_platform: linux-arm64-musl');
    expect(workflow).toContain(`build:binary --platform ${binaryPlatformExpression}`);
    expect(workflow).toContain(`stage-docker-ctx.ts --arch ${dockerArchExpression}`);
    expect(workflow).toContain(`--platform linux/${dockerArchExpression}`);
    expect(workflow).toContain('docker_arch: amd64');
    expect(workflow).toContain('docker_arch: arm64');
    expect(workflow).toContain('Dockerfile.alpine');
    expect(workflow).toContain('scripts/release/smoke-docker-image.sh');
    expect(smokeHelper).toContain('docker run -d');
    expect(smokeHelper).toContain('/api/health');
    expect(smokeHelper).toContain("grep -q '<html'");
    expect(smokeHelper).toContain('docker logs "$container_name"');
  });

  test('Dockerfile variants document their lockstep and stay byte-for-byte past the variant segments', () => {
    const dockerfile = readText('Dockerfile');
    const alpineDockerfile = readText('Dockerfile.alpine');

    for (const contents of [dockerfile, alpineDockerfile]) {
      expect(contents).toContain('Lockstep with the other MangoStudio image variant');
      expect(contents).toContain('the `FROM` base image');
      expect(contents).toContain('the user/package-install `RUN`');
      expect(contents).toContain('the variant segment inside the docker-ctx COPY paths');
    }

    // Strip the three documented variant segments so the remaining text must
    // be byte-for-byte identical. A drift here is the silent mistake the
    // lockstep comment warns against, so fail loudly when it happens.
    const normalize = (contents: string): string =>
      contents
        .replace(/^FROM .*$/m, 'FROM <variant>')
        .replace(/^RUN[\s\S]*?\n\n/m, 'RUN <variant>\n\n')
        .replace(/^COPY docker-ctx\/[a-z]+\//gm, 'COPY docker-ctx/<variant>/');

    expect(normalize(dockerfile)).toBe(normalize(alpineDockerfile));
  });

  test('binary and Docker smoke scripts share the wait-for-health helper', () => {
    const binarySmoke = readText('scripts/release/smoke-binary.sh');
    const dockerSmoke = readText('scripts/release/smoke-docker-image.sh');
    const healthHelper = readText('scripts/release/wait-for-health.sh');

    expect(healthHelper).toContain('wait_for_health()');
    expect(healthHelper).toContain('"status"[[:space:]]*:[[:space:]]*"ok"');

    for (const script of [binarySmoke, dockerSmoke]) {
      const bashSource = '$' + '{BASH_SOURCE[0]}';
      expect(script).toContain(
        `source "$(cd "$(dirname "${bashSource}")" && pwd)/wait-for-health.sh"`
      );
      expect(script).toContain('wait_for_health "$port"');
    }

    // The wait_for_health helper owns the JSON grep; the smoke scripts just
    // delegate. Catches a regression where someone re-inlines the loop.
    const inlineStatusMatch = /grep -Eq.+status/;
    expect(binarySmoke).not.toMatch(inlineStatusMatch);
    expect(dockerSmoke).not.toMatch(inlineStatusMatch);
  });
});
