import type { Page } from '@playwright/test';

type MotionSurface = 'route' | 'card' | 'dialog';

interface MotionSample {
  readonly elapsedMs: number;
  readonly opacity: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly animationDurationsMs: readonly number[];
}

export interface MotionObservation {
  readonly surface: MotionSurface;
  readonly label: string;
  readonly path: string;
  readonly samples: MotionSample[];
  removedAtMs?: number;
}

declare global {
  interface Window {
    __motionObservations?: MotionObservation[];
  }
}

/**
 * Observe computed styles from the real mounted library, from insertion through its frames.
 * This function is self-contained so Playwright can run it before application JavaScript.
 *
 * @example
 * await page.addInitScript(observeMotionNodes, { route: '[data-testid="route-container"]', card: 'section', dialog: '[role="dialog"]' });
 */
export function observeMotionNodes(selectors: Partial<Record<MotionSurface, string>>): void {
  const observations: MotionObservation[] = [];
  const recorded = new WeakSet<Element>();
  window.__motionObservations = observations;

  const record = (element: Element, surface: MotionSurface) => {
    if (!element.isConnected || recorded.has(element)) return;
    recorded.add(element);
    const started = performance.now();
    const observation: MotionObservation = {
      surface,
      label: element.querySelector('h3')?.textContent ?? element.getAttribute('aria-label') ?? '',
      path: window.location.pathname,
      samples: [],
    };
    observations.push(observation);

    const sample = () => {
      const elapsedMs = performance.now() - started;
      if (!element.isConnected) {
        observation.removedAtMs = elapsedMs;
        return;
      }
      const style = getComputedStyle(element);
      const transform = new DOMMatrixReadOnly(
        style.transform === 'none' ? undefined : style.transform
      );
      const durations = element
        .getAnimations()
        .map((animation) => animation.effect?.getTiming().duration);
      observation.samples.push({
        elapsedMs,
        opacity: Number(style.opacity),
        translateY: transform.m42,
        scaleX: transform.m11,
        animationDurationsMs: durations.filter(
          (duration): duration is number => typeof duration === 'number'
        ),
      });
      if (surface === 'dialog' || elapsedMs < 800) requestAnimationFrame(sample);
    };
    sample();
  };

  const inspect = (node: Element) => {
    const matches = (Object.entries(selectors) as [MotionSurface, string][]).flatMap(
      ([surface, selector]) =>
        [node, ...node.querySelectorAll(selector)]
          .filter((element) => element.matches(selector))
          .map((element) => ({ element, surface }))
    );
    for (const { element, surface } of matches) record(element, surface);
  };

  const observer = new MutationObserver((mutations) => {
    const nodes = mutations.flatMap((mutation) => [...mutation.addedNodes]);
    for (const node of nodes) {
      if (node instanceof Element) inspect(node);
    }
  });
  observer.observe(document, { childList: true, subtree: true });
}

/**
 * Read observations without replacing Motion or its clock.
 *
 * @example
 * const cards = (await readMotionObservations(page)).filter((entry) => entry.surface === 'card');
 */
export function readMotionObservations(page: Page): Promise<MotionObservation[]> {
  return page.evaluate(() => window.__motionObservations ?? []);
}
