import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const packageRoot = resolve('apps/frontend/node_modules/@xterm/addon-webgl');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  main: string;
  module: string;
};
const css = readFileSync('apps/frontend/node_modules/@xterm/xterm/css/xterm.css', 'utf8');
const bundles = new Map<string, string>();
let directory: string;

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader'] } });

test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'mango-webgl-constructor-'));
  for (const [format, entry] of Object.entries({ esm: manifest.module, cjs: manifest.main })) {
    const output = join(directory, `${format}.js`);
    execFileSync('bun', [
      '-e',
      `const [fixture, entry, output] = process.argv.slice(1);
      const result = await Bun.build({
        entrypoints: [fixture], target: 'browser',
        plugins: [{name: 'published-webgl-entry', setup(build) {
          build.onResolve({filter: /^@xterm\\/addon-webgl$/}, () => ({path: entry}));
        }}]
      });
      if (!result.success) throw new AggregateError(result.logs, 'Expected a browser fixture bundle');
      await Bun.write(output, result.outputs[0]);`,
      resolve('apps/frontend/tests/browser-support/webgl-constructor-fixture.ts'),
      resolve(packageRoot, entry),
      output,
    ]);
    bundles.set(format, readFileSync(output, 'utf8'));
  }
});

test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

for (const format of ['esm', 'cjs']) {
  for (const failure of [
    { kind: 'program', at: 1 },
    { kind: 'program', at: 2 },
    { kind: 'uniform', at: 1 },
  ]) {
    test(`${format}: allocation failure ${failure.kind}/${failure.at} releases partial renderer`, async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setContent(`<style>${css}</style>`);
      await page.addScriptTag({ content: bundles.get(format) });
      const result = await page.evaluate(
        `window.webglConstructorProbe(${JSON.stringify(failure)})`
      );
      await info.attach('renderer-allocation', {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      });
      expect(result.programCalls, 'expected a real WebGL program allocation').toBeGreaterThan(0);
      expect(result.observersCreated, 'expected a real device-pixel observer').toBeGreaterThan(0);
      expect(result.error, 'expected the selected native allocation to fail').not.toBeNull();
      expect(
        result.canvasesAfterAttempt,
        'expected constructor failure to remove its canvases'
      ).toBe(0);
      expect(result.canvasesAfterDispose).toBe(0);
      expect(result.pendingOwnedTimers).toBe(0);
      expect(result.pendingOwnedObservers).toBe(0);
      expect(result.text).toContain('DOM-AFTER-ALLOCATION-FAILURE');
      expect(result.contextsLost).toBe(result.contextCount);
      expect(result.childrenAfterTerminalDispose).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  for (const cleanupFault of ['dispose', 'lose-context']) {
    test(`${format}: ${cleanupFault} failure preserves the primary allocation error`, async ({
      page,
    }) => {
      await page.setContent(`<style>${css}</style>`);
      await page.addScriptTag({ content: bundles.get(format) });
      const at = cleanupFault === 'dispose' ? 2 : 1;
      const result = await page.evaluate(
        `window.webglConstructorProbe({kind:"program", at:${at}, cleanupFault:${JSON.stringify(cleanupFault)}})`
      );
      expect(result.programCalls).toBe(at);
      expect(result.cleanupFaults).toBe(1);
      expect(result.error).not.toBeNull();
      expect(result.error).not.toContain('fixture cleanup fault');
      expect(result.canvasesAfterAttempt).toBe(0);
      expect(result.pendingOwnedTimers).toBe(0);
      expect(result.pendingOwnedObservers).toBe(0);
      expect(result.text).toContain('DOM-AFTER-ALLOCATION-FAILURE');
    });
  }

  test(`${format}: unavailable WebGL leaves the DOM renderer usable`, async ({ page }) => {
    await page.setContent(`<style>${css}</style>`);
    await page.addScriptTag({ content: bundles.get(format) });
    const result = await page.evaluate('window.webglConstructorProbe({kind:"unsupported", at:0})');
    expect(result.error).toContain('WebGL2 not supported');
    expect(result.programCalls).toBe(0);
    expect(result.canvasesAfterAttempt).toBe(0);
    expect(result.pendingOwnedObservers).toBe(0);
    expect(result.pendingOwnedTimers).toBe(0);
    expect(result.text).toContain('DOM-AFTER-ALLOCATION-FAILURE');
  });

  test(`${format}: unavailable second renderer preserves the active renderer`, async ({ page }) => {
    await page.setContent(`<style>${css}</style>`);
    await page.addScriptTag({ content: bundles.get(format) });
    const result = await page.evaluate('window.webglExistingRendererProbe()');
    expect(result.error).toContain('WebGL2 not supported');
    expect(result.atlasUnchanged).toBe(true);
    expect(result.canvasesBefore).toBeGreaterThan(0);
    expect(result.canvasesAfter).toBe(result.canvasesBefore);
    expect(result.canvasesAfterDispose).toBe(0);
    expect(result.text).toContain('DOM-AFTER-REJECTED-RENDERER');
  });

  test(`${format}: successful renderer still mounts and returns to DOM on disposal`, async ({
    page,
  }) => {
    await page.setContent(`<style>${css}</style>`);
    await page.addScriptTag({ content: bundles.get(format) });
    const result = await page.evaluate('window.webglConstructorProbe({kind:"none", at:0})');
    expect(result.error).toBeNull();
    expect(result.canvasesAfterAttempt).toBeGreaterThan(0);
    expect(result.canvasesAfterDispose).toBe(0);
    expect(result.pendingOwnedTimers).toBe(0);
    expect(result.pendingOwnedObservers).toBe(0);
    expect(result.text).toContain('DOM-AFTER-ALLOCATION-FAILURE');
    expect(result.childrenAfterTerminalDispose).toBe(0);
  });
}

for (const format of ['esm', 'cjs']) {
  for (const failure of [
    { kind: 'shader', at: 1 },
    { kind: 'shader', at: 2 },
    { kind: 'compile', at: 1 },
    { kind: 'link', at: 1 },
    { kind: 'uniform', at: 2 },
    { kind: 'buffer', at: 1 },
    { kind: 'buffer', at: 2 },
    { kind: 'buffer', at: 3 },
    { kind: 'buffer', at: 4 },
    { kind: 'buffer', at: 5 },
    { kind: 'vertexarray', at: 1 },
    { kind: 'vertexarray', at: 2 },
    { kind: 'texture', at: 2 },
    { kind: 'limits', at: 2 },
    { kind: 'sentinel', at: 2, cleanupThrows: true },
    { kind: 'sentinel', at: 2, cleanupThrows: true, reportingThrows: true },
    { kind: 'none', at: 0 },
  ]) {
    test(`${format}: resource ownership ${failure.kind}/${failure.at}${'reportingThrows' in failure ? ' reporter-fault' : ''}`, async ({
      page,
    }, info) => {
      await page.setContent(`<style>${css}</style>`);
      await page.addScriptTag({ content: bundles.get(format) });
      const result = await page.evaluate(`window.webglResourceProbe(${JSON.stringify(failure)})`);
      await info.attach('native-api-ownership', {
        body: JSON.stringify(
          { ...result, browserVersion: page.context().browser()?.version() },
          null,
          2
        ),
        contentType: 'application/json',
      });
      expect(result.host.supported).toBe(true);
      expect(result.host.renderer).toContain('SwiftShader');
      if (failure.kind === 'none') expect(result.error).toBeNull();
      else expect(result.error).not.toBeNull();
      if (failure.kind === 'sentinel') {
        expect(result.primaryIdentity).toBe(true);
        expect(result.cleanupFaults).toBe(1);
      }
      if (failure.kind === 'limits')
        expect(
          result.healthy.unitsQueries,
          'healthy renderer must reinitialize both capability limits'
        ).toBe(1);
      expect(result.failed.created, 'expected real native GL allocations').toBeGreaterThan(0);
      expect(
        result.failed.live,
        'expected every owned GL object to receive native deletion without optional context loss'
      ).toEqual([]);
      expect(result.failed.duplicates).toEqual([]);
      expect(result.fallback.canvases).toBe(0);
      expect(result.fallback.text).toContain('DOM-RESOURCE-FALLBACK');
      expect(result.fallback.sameElement).toBe(true);
      expect(result.healthyError).toBeNull();
      expect(result.healthyCanvases).toBeGreaterThan(0);
      expect(result.painted, 'healthy real renderer must draw pixels').toBe(true);
      expect(result.glError).toBe(0);
      expect(result.healthy.live).toEqual([]);
      expect(result.healthy.duplicates).toEqual([]);
      expect(result.cleanupErrors).toEqual([]);
    });
  }
}
