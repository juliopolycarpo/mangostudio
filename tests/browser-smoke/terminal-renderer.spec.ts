import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import type {} from '../../apps/frontend/tests/browser-support/terminal-renderer-fixture';

// Headless hosts use an explicit software renderer for functional coverage.
// The attached host receipt keeps this separate from native GPU qualification.
test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader'] } });

let bundle: string;
const css = readFileSync(resolve('apps/frontend/node_modules/@xterm/xterm/css/xterm.css'), 'utf8');

test.beforeAll(() => {
  bundle = execFileSync(
    'bun',
    [
      '--eval',
      `const result = await Bun.build({ entrypoints: [process.argv[1]], target: 'browser' });
     if (!result.success) throw new AggregateError(result.logs, 'terminal fixture build failed');
     process.stdout.write(await result.outputs[0].text());`,
      resolve('apps/frontend/tests/browser-support/terminal-renderer-fixture.ts'),
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  );
});

test.beforeEach(async ({ page }, testInfo) => {
  // Serve the library fixture on the configured smoke origin. It uses the
  // production controller, not a replica, and never reaches the application.
  await page.route('**/__terminal-renderer-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><style>${css}</style><script>${bundle}</script>`,
    })
  );
  await page.goto('/__terminal-renderer-fixture');
  await page.waitForFunction(() => window.terminalFixture);
  const host = await page.evaluate(() => {
    const context = document.createElement('canvas').getContext('webgl2');
    const debug = context?.getExtension('WEBGL_debug_renderer_info');
    const renderer = context
      ? context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER)
      : null;
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return {
      supported: context !== null,
      renderer,
      dpr: devicePixelRatio,
      userAgent: navigator.userAgent,
    };
  });
  const hostPath = testInfo.outputPath('browser-host.json');
  writeFileSync(
    hostPath,
    JSON.stringify({ ...host, browserVersion: page.context().browser()?.version() }, null, 2)
  );
  await testInfo.attach('browser-host', { path: hostPath, contentType: 'application/json' });
  test.skip(
    !host.supported,
    'WebGL2 unavailable: real renderer lifecycle requires a supported context'
  );
});

test('real renderer preserves buffer, selection and grid through restored and expired loss', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const baseline = await page.evaluate(async () => {
    const fixture = window.terminalFixture;
    const h = fixture.createTerminal();
    window.terminalHarness = h;
    await h.write('ASCII: \x1b[31mRED\x1b[0m\r\nUnicode: café 中 🙂\r\nTARGET\r\n');
    await fixture.frames();
    h.term.select(0, 2, 6);
    return h.snapshot();
  });
  expect(baseline.selection).toBe('TARGET');
  expect(baseline.domRows).toBe(1);
  expect(baseline.canvases).toBe(0);
  const accelerated = await page.evaluate(async () => {
    window.terminalRenderer = window.terminalFixture.attachWebglRenderer(
      window.terminalHarness.term
    );
    await window.terminalRenderer.ready;
    await window.terminalFixture.frames();
    return window.terminalHarness.snapshot();
  });
  expect(accelerated.canvases, 'functional WebGL2 renderer must activate').toBeGreaterThan(0);
  expect(accelerated.text).toBe(baseline.text);
  expect(accelerated.selection).toBe(baseline.selection);
  await page.evaluate(async () => {
    const canvas = Array.from(
      window.terminalHarness.container.querySelectorAll<HTMLCanvasElement>('.xterm-screen > canvas')
    ).find((element) => element.getContext('webgl2'));
    const gl = canvas?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!canvas || !extension) throw new Error('expected active WebGL2 context loss extension');
    const lost = new Promise((resolve) =>
      canvas.addEventListener('webglcontextlost', resolve, { once: true })
    );
    extension.loseContext();
    await lost;
    const restored = new Promise((resolve) =>
      canvas.addEventListener('webglcontextrestored', resolve, { once: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    extension.restoreContext();
    await Promise.race([
      restored,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('expected WebGL context restoration within 5s')), 5000)
      ),
    ]);
    await window.terminalFixture.frames();
  });
  expect(await page.evaluate(() => window.terminalHarness.snapshot())).toEqual(accelerated);
  await page.evaluate(() => {
    const canvas = Array.from(
      window.terminalHarness.container.querySelectorAll<HTMLCanvasElement>('.xterm-screen > canvas')
    ).find((element) => element.getContext('webgl2'));
    const extension = canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('expected restorable renderer to remain active');
    extension.loseContext();
  });
  await expect
    .poll(() => page.evaluate(() => window.terminalHarness.snapshot().canvases), { timeout: 8_000 })
    .toBe(0);
  const fallback = await page.evaluate(async () => {
    const h = window.terminalHarness;
    await h.write('AFTER-FALLBACK\r\n');
    await window.terminalFixture.frames();
    return h.snapshot();
  });
  expect(fallback.text).toContain('AFTER-FALLBACK');
  expect(fallback.text).toContain('Unicode: café 中 🙂');
  expect(fallback.selection).toBe(baseline.selection);
  expect([fallback.cols, fallback.rows, fallback.domRows, fallback.a11y]).toEqual([80, 24, 1, 1]);
  const interaction = await page.evaluate(async () => {
    const h = window.terminalHarness;
    const found = h.search.findNext('TARGET');
    h.term.options.theme = { background: '#ffffff', foreground: '#000000' };
    h.term.options.fontSize = 16;
    h.term.resize(100, 30);
    await h.write(Array.from({ length: 100 }, (_, i) => `SCROLL_${i}\r\n`).join(''));
    h.term.scrollToTop();
    const top = h.term.buffer.active.viewportY;
    h.term.scrollToBottom();
    await window.terminalFixture.frames();
    return { found, top, bottom: h.term.buffer.active.viewportY, state: h.snapshot() };
  });
  expect(interaction.found).toBe(true);
  expect([interaction.state.cols, interaction.state.rows]).toEqual([100, 30]);
  expect(interaction.top).toBe(0);
  expect(interaction.bottom).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('dom-fallback.png') });
  const disposed = await page.evaluate(() => {
    window.terminalRenderer.dispose();
    window.terminalHarness.dispose();
    return window.terminalHarness.container.childElementCount;
  });
  expect(disposed).toBe(0);
  expect(errors).toEqual([]);
  await testInfo.attach('renderer-states', {
    body: JSON.stringify({ baseline, accelerated, fallback, interaction }, null, 2),
    contentType: 'application/json',
  });
});

test('disposed delayed imports never activate and repeated mounts remove terminal DOM', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { createTerminal, attachWebglRenderer, WebglAddon } = window.terminalFixture;
    const h = createTerminal();
    let resolveImport: (module: { WebglAddon: typeof WebglAddon }) => void = () => {
      throw new Error('expected deferred loader to install its resolver');
    };
    let constructed = 0;
    class ObservedWebglAddon extends WebglAddon {
      constructor() {
        super();
        constructed += 1;
      }
    }
    const renderer = attachWebglRenderer(h.term, {
      isSupported: () => true,
      loadModule: () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    });
    await h.write('DOM-USABLE-WHILE-PENDING');
    const pending = h.snapshot();
    renderer.dispose();
    h.dispose();
    resolveImport({ WebglAddon: ObservedWebglAddon });
    await renderer.ready;
    const mounts = [];
    for (let i = 0; i < 5; i += 1) {
      const mounted = createTerminal();
      const owner = attachWebglRenderer(mounted.term);
      await owner.ready;
      await mounted.write(`MOUNT_${i}`);
      const state = mounted.snapshot();
      owner.dispose();
      owner.dispose();
      mounted.dispose();
      mounts.push({ canvases: state.canvases, remaining: mounted.container.childElementCount });
    }
    return { pending, constructed, lateChildren: h.container.childElementCount, mounts };
  });
  expect(result.pending.text).toContain('DOM-USABLE-WHILE-PENDING');
  expect(result.pending.canvases).toBe(0);
  expect(result.constructed).toBe(0);
  expect(result.lateChildren).toBe(0);
  expect(result.mounts).toHaveLength(5);
  for (const mount of result.mounts) {
    expect(mount.canvases).toBeGreaterThan(0);
    expect(mount.remaining).toBe(0);
  }
});

for (const dpr of [1, 2]) {
  test.describe(`renderer options at emulated DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    test('links, clipboard, Unicode cells and live font/theme/grid options survive activation', async ({
      page,
    }, testInfo) => {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page
        .context()
        .route('https://terminal.example.test/**', async function terminalLinkDestination(route) {
          await route.fulfill({ contentType: 'text/plain', body: 'terminal link destination' });
        });
      const initial = await page.evaluate(async () => {
        const h = window.terminalFixture.createTerminal();
        window.terminalHarness = h;
        await h.write(
          'https://terminal.example.test/plain\r\n\x1b]8;;https://terminal.example.test/osc8\x07OSC_LINK\x1b]8;;\x07\r\ncafé 中 🙂\r\nTARGET\r\n'
        );
        await h.write('\x1b]52;c;V0VCR0wtQ0xJUEJPQVJE\x07');
        await window.terminalFixture.frames();
        const line = h.term.buffer.active.getLine(2);
        return {
          dpr: devicePixelRatio,
          combining: line?.getCell(3)?.getChars(),
          combiningWidth: line?.getCell(3)?.getWidth(),
          cjkWidth: line?.getCell(5)?.getWidth(),
          emojiWidth: line?.getCell(8)?.getWidth(),
          unicodeVersion: h.term.unicode.activeVersion,
          state: h.snapshot(),
        };
      });
      expect(initial.dpr).toBe(dpr);
      expect(initial.combining).toBe('é');
      expect(initial.combiningWidth).toBe(1);
      expect(initial.cjkWidth).toBe(2);
      expect(
        initial.unicodeVersion,
        'renderer fixture must use production Unicode version 11'
      ).toBe('11');
      expect(initial.emojiWidth, 'expected 🙂 to occupy two terminal cells').toBe(2);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('WEBGL-CLIPBOARD');

      const screen = page.locator('.xterm-screen');
      const box = await screen.boundingBox();
      if (!box) throw new Error('expected visible xterm screen for link interaction');
      for (const [row, path] of [
        [0, 'plain'],
        [1, 'osc8'],
      ] as const) {
        const x = box.x + (box.width / 80) * 4;
        const y = box.y + (box.height / 24) * (row + 0.5);
        await page.mouse.move(x, y);
        await expect(page.locator('.xterm-cursor-pointer')).toHaveCount(1);
        if (path === 'osc8') {
          page.once('dialog', async (dialog) => {
            expect(dialog.message()).toContain('https://terminal.example.test/osc8');
            await dialog.accept();
          });
        }
        const popupPromise = page.waitForEvent('popup');
        await page.mouse.click(x, y);
        const popup = await popupPromise;
        await expect(popup).toHaveURL(`https://terminal.example.test/${path}`);
        await popup.close();
      }
      const updated = await page.evaluate(async () => {
        const h = window.terminalHarness;
        const found = h.search.findNext('TARGET');
        const selection = h.term.getSelection();
        window.terminalRenderer = window.terminalFixture.attachWebglRenderer(h.term);
        await window.terminalRenderer.ready;
        await window.terminalFixture.frames();
        const canvas = Array.from(h.container.querySelectorAll('canvas')).find((entry) =>
          entry.getContext('webgl2')
        );
        if (!canvas) throw new Error('expected active WebGL canvas for DPR option test');
        const before = { width: canvas.width, height: canvas.height };
        const selectionBeforeResize = h.term.getSelection();
        h.term.options.fontSize = 18;
        h.term.options.theme = { background: '#ffffff', foreground: '#000000' };
        h.term.resize(100, 30);
        await window.terminalFixture.frames();
        const after = { width: canvas.width, height: canvas.height };
        const observedDevicePixels = await new Promise<{ width: number; height: number } | null>(
          (resolve) => {
            const observer = new ResizeObserver(([entry]) => {
              observer.disconnect();
              const size = entry?.devicePixelContentBoxSize?.[0];
              resolve(size ? { width: size.inlineSize, height: size.blockSize } : null);
            });
            observer.observe(canvas, { box: 'device-pixel-content-box' });
          }
        );
        // Xterm clears the selection on resize; searching again must select the
        // same content in the resized buffer. Activation itself preserves it.
        const searchAfterResize = h.search.findNext('TARGET');
        const result = {
          found,
          selection,
          selectionBeforeResize,
          searchAfterResize,
          observedDevicePixels,
          before,
          after,
          fontSize: h.term.options.fontSize,
          background: h.term.options.theme?.background,
          state: h.snapshot(),
          cssWidth: h.container.querySelector('.xterm-screen')?.getBoundingClientRect().width,
          cjkWidth: h.term.buffer.active.getLine(2)?.getCell(5)?.getWidth(),
          emojiWidth: h.term.buffer.active.getLine(2)?.getCell(8)?.getWidth(),
        };
        window.terminalRenderer.dispose();
        h.dispose();
        return { ...result, remaining: h.container.childElementCount };
      });
      const optionsPath = testInfo.outputPath('options-and-unicode.json');
      writeFileSync(optionsPath, JSON.stringify({ initial, updated }, null, 2));
      await testInfo.attach('options-and-unicode', {
        path: optionsPath,
        contentType: 'application/json',
      });
      expect(updated.found).toBe(true);
      expect(updated.selection).toBe('TARGET');
      expect(updated.selectionBeforeResize).toBe('TARGET');
      expect(updated.searchAfterResize).toBe(true);
      expect(updated.state.selection).toBe('TARGET');
      expect(updated.state.text).toContain('café 中 🙂');
      expect(updated.fontSize).toBe(18);
      expect(updated.background).toBe('#ffffff');
      expect([updated.state.cols, updated.state.rows]).toEqual([100, 30]);
      expect(updated.after.width).toBeGreaterThan(updated.before.width);
      expect(updated.after.height).toBeGreaterThan(updated.before.height);
      // Chromium DPR emulation can keep devicePixelContentBoxSize at native
      // scale. Match the same browser measurement xterm uses, recording both.
      expect(updated.after.width).toBeCloseTo(
        updated.observedDevicePixels?.width ?? (updated.cssWidth ?? 0) * dpr,
        0
      );
      expect(updated.cjkWidth).toBe(initial.cjkWidth);
      expect(updated.emojiWidth).toBe(initial.emojiWidth);
      expect(updated.remaining).toBe(0);
    });
  });
}
