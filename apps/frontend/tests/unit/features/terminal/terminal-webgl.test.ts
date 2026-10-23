import { beforeEach, describe, expect, it } from 'bun:test';
import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import {
  attachWebglRenderer,
  createWebglCapabilityProbe,
  type WebglRendererDependencies,
} from '../../../../src/features/terminal/terminal-webgl';

type RendererModule = Awaited<ReturnType<NonNullable<WebglRendererDependencies['loadModule']>>>;

class FakeProbeCanvas {
  requests = 0;
  losses = 0;
  supported = true;
  throws = false;
  hasLossExtension = true;

  create = () => this;
  getContext(_kind: 'webgl2') {
    this.requests += 1;
    if (this.throws) throw new Error('Synthetic capability probe failure');
    return this.supported ? { getExtension: this.getExtension } : null;
  }
  private getExtension = (_name: 'WEBGL_lose_context') =>
    this.hasLossExtension ? { loseContext: this.loseContext } : null;
  private loseContext = () => {
    this.losses += 1;
  };
}

class FakeWebglAddon implements ITerminalAddon {
  static instances: FakeWebglAddon[] = [];
  static failConstructor = false;
  static failActivation = false;
  static failSubscription = false;
  static failDisposal = false;
  static failUnsubscribe = false;
  activations = 0;
  disposals = 0;
  unsubscriptions = 0;
  private loss: (() => void) | undefined;

  constructor() {
    if (FakeWebglAddon.failConstructor) throw new Error('Synthetic WebGL constructor failure');
    FakeWebglAddon.instances.push(this);
  }
  activate(_terminal: Terminal): void {
    this.activations += 1;
    if (FakeWebglAddon.failActivation) throw new Error('Synthetic partial activation failure');
  }
  dispose(): void {
    this.disposals += 1;
    if (FakeWebglAddon.failDisposal) throw new Error('Synthetic addon disposal failure');
  }
  onContextLoss(listener: () => void): { dispose(): void } {
    if (FakeWebglAddon.failSubscription) throw new Error('Synthetic subscription failure');
    this.loss = listener;
    return { dispose: this.unsubscribe };
  }
  loseContext(): void {
    this.loss?.();
  }
  private unsubscribe = () => {
    this.unsubscriptions += 1;
    this.loss = undefined;
    if (FakeWebglAddon.failUnsubscribe) throw new Error('Synthetic unsubscribe failure');
  };
}

/** Mirrors xterm's registration-before-activation and idempotent wrapped disposal. */
class FakeTerminal {
  readonly element = document.createElement('div');
  readonly addons: ITerminalAddon[] = [];
  disposed = false;

  loadAddon(addon: ITerminalAddon): void {
    const dispose = addon.dispose.bind(addon);
    let disposed = false;
    addon.dispose = () => {
      if (disposed) return;
      disposed = true;
      dispose();
    };
    this.addons.push(addon);
    addon.activate(this as unknown as Terminal);
  }
  dispose(): void {
    this.disposed = true;
    for (const addon of this.addons) addon.dispose();
  }
}

class FakeAddonLoader {
  requests = 0;
  readonly result = Promise.withResolvers<RendererModule>();
  load = () => {
    this.requests += 1;
    return this.result.promise;
  };
  resolve(): void {
    this.result.resolve({ WebglAddon: FakeWebglAddon });
  }
}

function supported(): boolean {
  return true;
}
function unsupported(): boolean {
  return false;
}
function failedCapability(): never {
  throw new Error('Synthetic injected capability failure');
}

beforeEach(() => {
  FakeWebglAddon.instances = [];
  FakeWebglAddon.failConstructor = false;
  FakeWebglAddon.failActivation = false;
  FakeWebglAddon.failSubscription = false;
  FakeWebglAddon.failDisposal = false;
  FakeWebglAddon.failUnsubscribe = false;
});

describe('WebGL capability probe', () => {
  it('caches capability and releases its one temporary context', () => {
    const canvas = new FakeProbeCanvas();
    const probe = createWebglCapabilityProbe(canvas.create);
    expect(probe()).toBe(true);
    expect(probe()).toBe(true);
    expect(canvas.requests).toBe(1);
    expect(canvas.losses).toBe(1);
  });

  it('caches unsupported and throwing probes', () => {
    const absent = new FakeProbeCanvas();
    absent.supported = false;
    const unsupportedProbe = createWebglCapabilityProbe(absent.create);
    expect(unsupportedProbe()).toBe(false);
    expect(unsupportedProbe()).toBe(false);
    expect(absent.requests).toBe(1);
    expect(absent.losses).toBe(0);
    const failing = new FakeProbeCanvas();
    failing.throws = true;
    const failedProbe = createWebglCapabilityProbe(failing.create);
    expect(failedProbe()).toBe(false);
    expect(failedProbe()).toBe(false);
    expect(failing.requests).toBe(1);
  });

  it('supports contexts without the optional loss extension', () => {
    const canvas = new FakeProbeCanvas();
    canvas.hasLossExtension = false;
    expect(createWebglCapabilityProbe(canvas.create)()).toBe(true);
    expect(canvas.losses).toBe(0);
  });
});

describe('optional WebGL renderer ownership', () => {
  it.each([unsupported, failedCapability])(
    'stays on DOM when capability refuses or throws',
    async (probe) => {
      const terminal = new FakeTerminal();
      const loader = new FakeAddonLoader();
      const renderer = attachWebglRenderer(terminal, {
        isSupported: probe,
        loadModule: loader.load,
      });
      await renderer.ready;
      renderer.dispose();
      expect(loader.requests).toBe(0);
      expect(terminal.addons).toHaveLength(0);
      expect(terminal.disposed).toBe(false);
    }
  );

  it('does not allocate or activate when import resolves after synchronous disposal', async () => {
    const terminal = new FakeTerminal();
    const loader = new FakeAddonLoader();
    const renderer = attachWebglRenderer(terminal, {
      isSupported: supported,
      loadModule: loader.load,
    });
    expect(terminal.addons).toHaveLength(0);
    renderer.dispose();
    terminal.dispose();
    expect(terminal.element).toBeTruthy();
    loader.resolve();
    await renderer.ready;
    expect(FakeWebglAddon.instances).toHaveLength(0);
    expect(terminal.addons).toHaveLength(0);
  });

  it('settles a rejected import without retries or terminal replacement', async () => {
    const terminal = new FakeTerminal();
    const loader = new FakeAddonLoader();
    const renderer = attachWebglRenderer(terminal, {
      isSupported: supported,
      loadModule: loader.load,
    });
    loader.result.reject(new Error('Synthetic addon module download failure'));
    await renderer.ready;
    renderer.dispose();
    expect(loader.requests).toBe(1);
    expect(terminal.addons).toHaveLength(0);
    expect(terminal.disposed).toBe(false);
  });

  it('settles a throwing constructor before addon registration', async () => {
    FakeWebglAddon.failConstructor = true;
    const terminal = new FakeTerminal();
    const loader = new FakeAddonLoader();
    const renderer = attachWebglRenderer(terminal, {
      isSupported: supported,
      loadModule: loader.load,
    });
    loader.resolve();
    await renderer.ready;
    renderer.dispose();
    expect(FakeWebglAddon.instances).toHaveLength(0);
    expect(terminal.addons).toHaveLength(0);
  });

  it.each(['subscription', 'activation'] as const)(
    'releases an allocated addon after %s failure',
    async (failure) => {
      FakeWebglAddon.failSubscription = failure === 'subscription';
      FakeWebglAddon.failActivation = failure === 'activation';
      const terminal = new FakeTerminal();
      const loader = new FakeAddonLoader();
      const renderer = attachWebglRenderer(terminal, {
        isSupported: supported,
        loadModule: loader.load,
      });
      loader.resolve();
      await renderer.ready;
      const addon = FakeWebglAddon.instances[0];
      expect(addon?.disposals).toBe(1);
      expect(addon?.unsubscriptions).toBe(failure === 'activation' ? 1 : 0);
      renderer.dispose();
      terminal.dispose();
      expect(addon?.disposals).toBe(1);
    }
  );

  it('disposes on public context loss once without retrying for the remaining view', async () => {
    const terminal = new FakeTerminal();
    const loader = new FakeAddonLoader();
    const renderer = attachWebglRenderer(terminal, {
      isSupported: supported,
      loadModule: loader.load,
    });
    loader.resolve();
    await renderer.ready;
    const addon = FakeWebglAddon.instances[0];
    addon?.loseContext();
    addon?.loseContext();
    renderer.dispose();
    terminal.dispose();
    expect(addon?.disposals).toBe(1);
    expect(addon?.unsubscriptions).toBe(1);
    expect(loader.requests).toBe(1);
  });

  it('allows terminal-owned cleanup first and survives optional disposal failures', async () => {
    const terminal = new FakeTerminal();
    const loader = new FakeAddonLoader();
    const renderer = attachWebglRenderer(terminal, {
      isSupported: supported,
      loadModule: loader.load,
    });
    loader.resolve();
    await renderer.ready;
    terminal.dispose();
    FakeWebglAddon.failUnsubscribe = true;
    expect(() => renderer.dispose()).not.toThrow();
    expect(FakeWebglAddon.instances[0]?.disposals).toBe(1);
    expect(FakeWebglAddon.instances[0]?.unsubscriptions).toBe(1);
  });

  it('attempts every owned cleanup even when both disposers throw', async () => {
    const terminal = new FakeTerminal();
    const loader = new FakeAddonLoader();
    const renderer = attachWebglRenderer(terminal, {
      isSupported: supported,
      loadModule: loader.load,
    });
    loader.resolve();
    await renderer.ready;
    FakeWebglAddon.failDisposal = true;
    FakeWebglAddon.failUnsubscribe = true;
    expect(() => renderer.dispose()).not.toThrow();
    expect(() => renderer.dispose()).not.toThrow();
    expect(() => terminal.dispose()).not.toThrow();
    expect(FakeWebglAddon.instances[0]?.disposals).toBe(1);
    expect(FakeWebglAddon.instances[0]?.unsubscriptions).toBe(1);
  });

  it('probes once per document but makes one addon attempt for each new view', async () => {
    const canvas = new FakeProbeCanvas();
    const probe = createWebglCapabilityProbe(canvas.create);
    for (let mount = 0; mount < 5; mount += 1) {
      const terminal = new FakeTerminal();
      const loader = new FakeAddonLoader();
      const renderer = attachWebglRenderer(terminal, {
        isSupported: probe,
        loadModule: loader.load,
      });
      loader.resolve();
      await renderer.ready;
      renderer.dispose();
      terminal.dispose();
      expect(loader.requests).toBe(1);
    }
    expect(canvas.requests).toBe(1);
    expect(canvas.losses).toBe(1);
    expect(FakeWebglAddon.instances).toHaveLength(5);
    expect(FakeWebglAddon.instances.map((addon) => addon.disposals)).toEqual([1, 1, 1, 1, 1]);
  });
});
