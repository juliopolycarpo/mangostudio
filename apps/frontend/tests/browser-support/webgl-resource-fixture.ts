import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

type Fault =
  | 'shader'
  | 'uniform'
  | 'buffer'
  | 'vertexarray'
  | 'texture'
  | 'compile'
  | 'link'
  | 'limits'
  | 'sentinel'
  | 'none';
interface ResourceFailure {
  readonly kind: Fault;
  readonly at: number;
  readonly cleanupThrows?: boolean;
  readonly reportingThrows?: boolean;
}

/** Native API ledger: deletion requests are distinct from driver/GPU reclamation. */
class NativeGlLedger {
  readonly primary = new Error('named original GL constructor failure');
  readonly cleanup = new Error('named after-delegation cleanup failure');
  readonly objects = new Map<object, { kind: string; phase: string; deletions: number }>();
  readonly contexts = new Set<WebGL2RenderingContext>();
  readonly restores: (() => void)[] = [];
  readonly calls = new Map<string, number>();
  phase = 'failed';
  disabled = false;
  cleanupFaults = 0;
  faultCalls = 0;

  constructor(readonly failure: ResourceFailure) {
    if (failure.reportingThrows) {
      const original = console.error;
      console.error = function failedSecondaryReport() {
        throw new Error('named secondary reporter failure');
      };
      this.restores.push(() => {
        console.error = original;
      });
    }
    const prototype = WebGL2RenderingContext.prototype;
    for (const kind of ['Program', 'Shader', 'VertexArray', 'Buffer', 'Texture']) {
      this.wrap(prototype, `create${kind}`, (original, receiver, args) => {
        if (this.selected(kind.toLowerCase())) return null;
        const value = Reflect.apply(original, receiver, args);
        if (value) this.objects.set(value, { kind, phase: this.phase, deletions: 0 });
        return value;
      });
      this.wrap(prototype, `delete${kind}`, (original, receiver, args) => {
        const value = Reflect.apply(original, receiver, args);
        const record = this.objects.get(args[0] as object);
        if (record) record.deletions++;
        if (kind === 'Program' && this.failure.cleanupThrows && this.cleanupFaults === 0) {
          this.cleanupFaults++;
          throw this.cleanup;
        }
        return value;
      });
    }
    this.wrap(prototype, 'getUniformLocation', (original, receiver, args) => {
      if (this.selected(this.failure.kind === 'sentinel' ? 'sentinel' : 'uniform')) {
        if (this.failure.kind === 'sentinel') throw this.primary;
        return null;
      }
      return Reflect.apply(original, receiver, args);
    });
    this.wrap(prototype, 'getShaderParameter', (original, receiver, args) => {
      if (args[1] === receiver.COMPILE_STATUS && this.selected('compile')) return false;
      return Reflect.apply(original, receiver, args);
    });
    this.wrap(prototype, 'getProgramParameter', (original, receiver, args) => {
      if (args[1] === receiver.LINK_STATUS && this.selected('link')) return false;
      return Reflect.apply(original, receiver, args);
    });
    this.wrap(prototype, 'getParameter', (original, receiver, args) => {
      if (args[0] === receiver.MAX_TEXTURE_IMAGE_UNITS) this.count('units');
      if (args[0] === receiver.MAX_TEXTURE_SIZE) {
        this.count('size');
        if (this.selected('limits')) return null;
      }
      return Reflect.apply(original, receiver, args);
    });
    // Individual resource deletion must work without optional context-wide fallback.
    this.wrap(prototype, 'getExtension', (original, receiver, args) =>
      args[0] === 'WEBGL_lose_context' ? null : Reflect.apply(original, receiver, args)
    );
  }

  private count(name: string): number {
    const key = `${this.phase}:${name}`;
    const value = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, value);
    return value;
  }

  private selected(kind: string): boolean {
    if (this.disabled || this.failure.kind !== kind) return false;
    this.faultCalls++;
    return this.count(`fault:${kind}`) === this.failure.at;
  }

  private wrap(
    target: object,
    name: string,
    run: (
      original: (...args: unknown[]) => unknown,
      receiver: WebGL2RenderingContext,
      args: unknown[]
    ) => unknown
  ): void {
    const original = Reflect.get(target, name);
    if (typeof original !== 'function') throw new Error(`GL ${name}: expected native function`);
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- The callback needs its own this, while the alias retains the enclosing instance.
    const owner = this;
    Reflect.set(
      target,
      name,
      function nativeGlObservation(this: WebGL2RenderingContext, ...args: unknown[]) {
        owner.contexts.add(this);
        return run(original, this, args);
      }
    );
    this.restores.push(() => Reflect.set(target, name, original));
  }

  snapshot(phase: string) {
    const records = [...this.objects.values()].filter((entry) => entry.phase === phase);
    return {
      created: records.length,
      live: records.filter((entry) => entry.deletions === 0).map((entry) => entry.kind),
      duplicates: records.filter((entry) => entry.deletions > 1).map((entry) => entry.kind),
      unitsQueries: this.calls.get(`${phase}:units`) ?? 0,
      sizeQueries: this.calls.get(`${phase}:size`) ?? 0,
    };
  }

  restore(): void {
    for (const restore of this.restores.reverse()) restore();
    // Emergency fixture cleanup is after observations and never counted as vendor deletion.
    for (const context of this.contexts) context.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function terminalFixture() {
  const container = document.createElement('div');
  container.style.cssText = 'width:900px;height:600px';
  document.body.append(container);
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    cursorBlink: true,
    theme: { background: '#000000', foreground: '#ffffff' },
  });
  terminal.open(container);
  terminal.focus();
  return { terminal, container, addon: new WebglAddon(true) };
}

async function frames(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

/**
 * Inject one allocation fault into real WebGL and record both failed and healthy-next ownership.
 * Example: await window.webglResourceProbe({ kind: 'texture', at: 2 });
 */
async function webglResourceProbe(failure: ResourceFailure) {
  const probe = document.createElement('canvas').getContext('webgl2');
  const debug = probe?.getExtension('WEBGL_debug_renderer_info');
  const host = {
    supported: probe !== null,
    renderer: probe?.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : probe.RENDERER),
    userAgent: navigator.userAgent,
  };
  probe?.getExtension('WEBGL_lose_context')?.loseContext();
  const first = terminalFixture();
  const element = first.container.querySelector('.xterm');
  const ledger = new NativeGlLedger(failure);
  let next: ReturnType<typeof terminalFixture> | undefined;
  let error: unknown;
  let healthyError: string | null = null;
  const cleanupErrors: string[] = [];
  try {
    try {
      first.terminal.loadAddon(first.addon);
    } catch (caught) {
      error = caught;
    }
    ledger.disabled = true;
    first.addon.dispose();
    await new Promise<void>((resolve) => first.terminal.write('DOM-RESOURCE-FALLBACK', resolve));
    await frames();
    const failed = ledger.snapshot('failed');
    const fallback = {
      canvases: first.container.querySelectorAll('.xterm-screen > canvas').length,
      text: first.container.querySelector('.xterm-rows')?.textContent,
      sameElement: element === first.container.querySelector('.xterm'),
    };
    ledger.phase = 'healthy';
    next = terminalFixture();
    let painted = false;
    let glError: number | undefined;
    try {
      next.terminal.loadAddon(next.addon);
      await new Promise<void>((resolve) => next?.terminal.write('HEALTHY-NEXT', resolve));
      await frames();
      const context = [...ledger.contexts].at(-1);
      if (context) {
        const pixels = new Uint8Array(context.drawingBufferWidth * context.drawingBufferHeight * 4);
        context.readPixels(
          0,
          0,
          context.drawingBufferWidth,
          context.drawingBufferHeight,
          context.RGBA,
          context.UNSIGNED_BYTE,
          pixels
        );
        painted = pixels.some((value, index) => index % 4 !== 3 && value !== 0);
        glError = context.getError();
      }
    } catch (caught) {
      healthyError = String(caught);
    }
    const healthyCanvases = next.container.querySelectorAll('.xterm-screen > canvas').length;
    next.addon.dispose();
    return {
      host,
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- The fixture records the original diagnostic using JavaScript string conversion.
      error: error === undefined ? null : String(error),
      primaryIdentity: error === ledger.primary,
      cleanupFaults: ledger.cleanupFaults,
      faultCalls: ledger.faultCalls,
      failed,
      fallback,
      healthy: ledger.snapshot('healthy'),
      healthyCanvases,
      healthyError,
      painted,
      glError,
      cleanupErrors,
    };
  } finally {
    for (const fixture of [first, next]) {
      if (!fixture) continue;
      for (const cleanup of [
        () => fixture.addon.dispose(),
        () => fixture.terminal.dispose(),
        () => fixture.container.remove(),
      ]) {
        try {
          cleanup();
        } catch (caught) {
          cleanupErrors.push(String(caught));
        }
      }
    }
    ledger.restore();
  }
}

declare global {
  interface Window {
    webglResourceProbe: typeof webglResourceProbe;
  }
}
window.webglResourceProbe = webglResourceProbe;
