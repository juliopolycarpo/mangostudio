import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { attachWebglRenderer } from '../../src/features/terminal/terminal-webgl';

function createTerminal() {
  const container = document.createElement('div');
  container.style.cssText = 'width:900px;height:600px';
  document.body.append(container);
  const term = new Terminal({
    cols: 80,
    rows: 24,
    fontFamily: 'monospace',
    fontSize: 14,
    screenReaderMode: true,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  const search = new SearchAddon();
  term.loadAddon(search);
  term.loadAddon(new ClipboardAddon());
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon());
  term.open(container);
  return {
    term,
    container,
    search,
    write: (text: string) => new Promise<void>((resolve) => term.write(text, resolve)),
    snapshot: () => ({
      text: Array.from({ length: term.buffer.active.length }, (_, i) =>
        term.buffer.active.getLine(i)?.translateToString(true)
      ).join('\n'),
      selection: term.getSelection(),
      rows: term.rows,
      cols: term.cols,
      domRows: container.querySelectorAll('.xterm-rows').length,
      canvases: container.querySelectorAll('.xterm-screen > canvas').length,
      a11y: container.querySelectorAll('.xterm-accessibility').length,
    }),
    dispose: () => term.dispose(),
  };
}

const fixture = {
  createTerminal,
  attachWebglRenderer,
  WebglAddon,
  frames: () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    ),
};

declare global {
  interface Window {
    terminalFixture: typeof fixture;
    terminalHarness: ReturnType<typeof createTerminal>;
    terminalRenderer: ReturnType<typeof attachWebglRenderer>;
  }
}
window.terminalFixture = fixture;
