/**
 * `navigator.clipboard.writeText` substitution, undone by the suite-wide
 * `afterEach` in `bun.setup.ts`.
 *
 * jsdom left `navigator.clipboard` writable, so the Vitest-era spelling was
 * `Object.assign(navigator, { clipboard })`. happy-dom defines it as a readonly
 * getter and that throws `Attempted to assign to readonly property`, which is
 * why every call site had to switch to a property descriptor — and why three
 * files ended up with three different versions of the same dance, only one of
 * which put the original back.
 *
 * Restoring matters even under `--isolate`: within one file, a stub left in
 * place is the clipboard every later test in that file sees.
 */

/** The descriptor to put back, captured before the first stub of this test. */
let original: PropertyDescriptor | undefined;
let stubbed = false;

/** Install a `writeText` double for the current test. */
export function stubClipboard(writeText: (text: string) => Promise<void>): void {
  if (!stubbed) {
    original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    stubbed = true;
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

/** Put the real `navigator.clipboard` back. A no-op when nothing stubbed it. */
export function restoreClipboard(): void {
  if (!stubbed) return;
  if (original) {
    Object.defineProperty(navigator, 'clipboard', original);
  } else {
    // happy-dom may not define it at all; deleting is the only honest undo.
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  original = undefined;
  stubbed = false;
}
