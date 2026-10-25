import './webgl-resource-fixture';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

interface AllocationFailure {
  readonly kind: 'program' | 'uniform' | 'none' | 'unsupported';
  readonly cleanupFault?: 'dispose' | 'lose-context';
  readonly at: number;
}

/**
 * Exercises partial construction through the installed addon's public API.
 * Example: await window.webglConstructorProbe({ kind: 'program', at: 1 });
 */
async function webglConstructorProbe(failure: AllocationFailure) {
  const container = document.createElement('div');
  container.style.cssText = 'width:900px;height:600px';
  document.body.append(container);
  const terminal = new Terminal({ cols: 80, rows: 24, cursorBlink: true });
  terminal.open(container);
  terminal.focus();

  const prototype = WebGL2RenderingContext.prototype;
  const createProgram = prototype.createProgram;
  const getUniformLocation = prototype.getUniformLocation;
  const getExtension = prototype.getExtension;
  const deleteProgram = prototype.deleteProgram;
  const getContext = HTMLCanvasElement.prototype.getContext;
  const setTimeout = window.setTimeout;
  const clearTimeout = window.clearTimeout;
  const ResizeObserver = window.ResizeObserver;
  const timers = new Map<number, number>();
  const observers = new Set<globalThis.ResizeObserver>();
  let cleanupFaults = 0;
  let observersCreated = 0;

  function recordTimeout(handler: TimerHandler, delay?: number, ...args: unknown[]) {
    const id = Number(Reflect.apply(setTimeout, window, [handler, delay, ...args]));
    if (delay === 600 || delay === 3000) timers.set(Number(id), delay);
    return id;
  }
  function clearRecordedTimeout(id?: number) {
    timers.delete(Number(id));
    return clearTimeout.call(window, id);
  }
  class OwnedResizeObserver extends ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      observers.add(this);
      observersCreated += 1;
    }
    override disconnect() {
      observers.delete(this);
      super.disconnect();
    }
  }
  function unavailableContext(this: HTMLCanvasElement, id: string, ...args: unknown[]) {
    if (failure.kind === 'unsupported' && id === 'webgl2') return null;
    return Reflect.apply(getContext, this, [id, ...args]);
  }
  function optionalCleanupExtension(this: WebGL2RenderingContext, name: string) {
    if (failure.cleanupFault === 'lose-context' && name === 'WEBGL_lose_context') {
      return {
        loseContext() {
          cleanupFaults += 1;
          throw new Error('fixture cleanup fault');
        },
      };
    }
    return Reflect.apply(getExtension, this, [name]);
  }
  function failedProgramDisposal(this: WebGL2RenderingContext, program: WebGLProgram | null) {
    if (failure.cleanupFault === 'dispose') {
      cleanupFaults += 1;
      throw new Error('fixture cleanup fault');
    }
    return deleteProgram.call(this, program);
  }
  const contexts = new Set<WebGL2RenderingContext>();
  let programCalls = 0;
  let uniformCalls = 0;
  let error: string | null = null;

  function failSelectedProgram(this: WebGL2RenderingContext) {
    contexts.add(this);
    programCalls += 1;
    if (failure.kind === 'program' && programCalls === failure.at) return null;
    return createProgram.call(this);
  }

  function failSelectedUniform(this: WebGL2RenderingContext, program: WebGLProgram, name: string) {
    uniformCalls += 1;
    if (failure.kind === 'uniform' && uniformCalls === failure.at) return null;
    return getUniformLocation.call(this, program, name);
  }

  const addon = new WebglAddon();
  try {
    prototype.createProgram = failSelectedProgram as typeof prototype.createProgram;
    prototype.getExtension = optionalCleanupExtension as typeof prototype.getExtension;
    prototype.deleteProgram = failedProgramDisposal;
    HTMLCanvasElement.prototype.getContext = unavailableContext as typeof getContext;
    window.setTimeout = recordTimeout as unknown as typeof window.setTimeout;
    window.clearTimeout = clearRecordedTimeout as typeof window.clearTimeout;
    window.ResizeObserver = OwnedResizeObserver;
    prototype.getUniformLocation = failSelectedUniform;
    try {
      terminal.loadAddon(addon);
    } catch (caught) {
      error = String(caught);
    } finally {
      prototype.createProgram = createProgram;
      prototype.getUniformLocation = getUniformLocation;
    }

    const canvasesAfterAttempt = container.querySelectorAll('.xterm-screen > canvas').length;
    addon.dispose();
    // A detached canvas must no longer keep context listeners/timers alive.
    for (const context of contexts) {
      context.canvas.dispatchEvent(new WebGLContextEvent('webglcontextlost', { cancelable: true }));
    }
    const pendingOwnedTimers = timers.size;
    const pendingOwnedObservers = observers.size;
    await new Promise<void>((resolve) => terminal.write('DOM-AFTER-ALLOCATION-FAILURE', resolve));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const result = {
      error,
      programCalls,
      uniformCalls,
      cleanupFaults,
      pendingOwnedTimers,
      pendingOwnedObservers,
      observersCreated,
      canvasesAfterAttempt,
      canvasesAfterDispose: container.querySelectorAll('.xterm-screen > canvas').length,
      text: container.querySelector('.xterm-rows')?.textContent,
      contextCount: contexts.size,
      contextsLost: [...contexts].filter((context) => context.isContextLost()).length,
    };
    terminal.dispose();
    return { ...result, childrenAfterTerminalDispose: container.childElementCount };
  } finally {
    prototype.createProgram = createProgram;
    prototype.getUniformLocation = getUniformLocation;
    addon.dispose();
    terminal.dispose();
    container.remove();
    prototype.getExtension = getExtension;
    prototype.deleteProgram = deleteProgram;
    HTMLCanvasElement.prototype.getContext = getContext;
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    window.ResizeObserver = ResizeObserver;
  }
}

/**
 * Verify a rejected optional renderer cannot dispose an existing renderer's cache or canvases.
 * Example: await window.webglExistingRendererProbe();
 */
async function webglExistingRendererProbe() {
  const container = document.createElement('div');
  container.style.cssText = 'width:900px;height:600px';
  document.body.append(container);
  const terminal = new Terminal({ cols: 80, rows: 24 });
  const active = new WebglAddon();
  const rejected = new WebglAddon();
  const getContext = HTMLCanvasElement.prototype.getContext;
  function unsupportedSecondContext(this: HTMLCanvasElement, id: string, ...args: unknown[]) {
    if (id === 'webgl2') return null;
    return Reflect.apply(getContext, this, [id, ...args]);
  }
  let error: string | null = null;
  try {
    terminal.open(container);
    terminal.loadAddon(active);
    const atlas = active.textureAtlas;
    const canvasesBefore = container.querySelectorAll('.xterm-screen > canvas').length;
    try {
      HTMLCanvasElement.prototype.getContext = unsupportedSecondContext as typeof getContext;
      terminal.loadAddon(rejected);
    } catch (caught) {
      error = String(caught);
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
      rejected.dispose();
    }
    await new Promise<void>((resolve) => terminal.write('EXISTING-RENDERER-SURVIVES', resolve));
    const atlasUnchanged = active.textureAtlas === atlas && atlas !== undefined && atlas.width > 0;
    const canvasesAfter = container.querySelectorAll('.xterm-screen > canvas').length;
    active.dispose();
    await new Promise<void>((resolve) => terminal.write('DOM-AFTER-REJECTED-RENDERER', resolve));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      error,
      atlasUnchanged,
      canvasesBefore,
      canvasesAfter,
      canvasesAfterDispose: container.querySelectorAll('.xterm-screen > canvas').length,
      text: container.querySelector('.xterm-rows')?.textContent,
    };
  } finally {
    HTMLCanvasElement.prototype.getContext = getContext;
    rejected.dispose();
    active.dispose();
    terminal.dispose();
    container.remove();
  }
}

declare global {
  interface Window {
    webglConstructorProbe: typeof webglConstructorProbe;
    webglExistingRendererProbe: typeof webglExistingRendererProbe;
  }
}

window.webglConstructorProbe = webglConstructorProbe;
window.webglExistingRendererProbe = webglExistingRendererProbe;
