import type { ITerminalAddon, Terminal } from '@xterm/xterm';

interface Disposable {
  dispose(): void;
}

interface ProbeCanvas {
  getContext(kind: 'webgl2'): {
    getExtension(name: 'WEBGL_lose_context'): { loseContext(): void } | null;
  } | null;
}

interface RendererAddon extends ITerminalAddon {
  onContextLoss(listener: () => void): Disposable;
}

interface RendererModule {
  readonly WebglAddon: new () => RendererAddon;
}

export interface WebglRendererDependencies {
  readonly isSupported?: () => boolean;
  readonly loadModule?: () => Promise<RendererModule>;
}

/**
 * Probes once and releases its temporary GPU context when that extension exists.
 * Example: const isSupported = createWebglCapabilityProbe(); isSupported();
 */
export function createWebglCapabilityProbe(
  createCanvas: () => ProbeCanvas = () => document.createElement('canvas')
): () => boolean {
  let supported: boolean | null = null;
  return () => {
    if (supported !== null) return supported;
    try {
      const context = createCanvas().getContext('webgl2');
      context?.getExtension('WEBGL_lose_context')?.loseContext();
      supported = context !== null;
    } catch {
      supported = false;
    }
    return supported;
  };
}

const canUseWebgl = createWebglCapabilityProbe();

function loadWebglModule(): Promise<RendererModule> {
  return import('@xterm/addon-webgl');
}

function disposeQuietly(resource: Disposable | undefined): void {
  try {
    resource?.dispose();
  } catch {
    // A failing optional renderer must not prevent the terminal's own cleanup.
  }
}

/**
 * Owns one optional renderer attempt while the terminal and socket stay with their view.
 * Example: const renderer = attachWebglRenderer(term); await renderer.ready; renderer.dispose();
 */
export function attachWebglRenderer(
  terminal: Pick<Terminal, 'loadAddon'>,
  { isSupported = canUseWebgl, loadModule = loadWebglModule }: WebglRendererDependencies = {}
): { readonly ready: Promise<void>; dispose(): void } {
  let disposed = false;
  let addon: RendererAddon | undefined;
  let contextLoss: Disposable | undefined;

  function release(): void {
    const subscription = contextLoss;
    const renderer = addon;
    contextLoss = undefined;
    addon = undefined;
    disposeQuietly(subscription);
    disposeQuietly(renderer);
  }

  async function initialize(): Promise<void> {
    try {
      if (!isSupported()) return;
      const { WebglAddon } = await loadModule();
      if (disposed) return;
      addon = new WebglAddon();
      contextLoss = addon.onContextLoss(release);
      terminal.loadAddon(addon);
    } catch {
      release();
      // term.open() already installed the DOM fallback; do not retry or reconnect.
    }
  }

  return {
    ready: initialize(),
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
    },
  };
}
