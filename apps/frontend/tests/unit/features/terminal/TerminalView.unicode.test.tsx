import { expect, it, spyOn } from 'bun:test';
import { act, waitFor } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { TerminalView } from '../../../../src/features/terminal/TerminalView';
import { render } from '../../../support/harness/render';
import { FakeTerminalSocket } from './fake-terminal-socket';

it('uses Unicode 11 widths for session output after the socket resets the terminal', async () => {
  FakeTerminalSocket.instances = [];
  const loadAddon = Terminal.prototype.loadAddon;
  let mounted: Terminal | undefined;
  const capture = spyOn(Terminal.prototype, 'loadAddon').mockImplementation(
    function captureTerminal(this: Terminal, addon: Parameters<Terminal['loadAddon']>[0]) {
      mounted = this;
      loadAddon.call(this, addon);
    }
  );
  try {
    render(
      <TerminalView
        sessionId="unicode-session"
        createSocket={(url) => new FakeTerminalSocket(url) as unknown as WebSocket}
        resolveUrl={() => 'ws://terminal.test/api/terminal/unicode-session'}
      />
    );
    const term = mounted;
    if (!term) throw new Error('expected TerminalView to mount a real xterm terminal');
    const socket = FakeTerminalSocket.instances[0];
    if (!socket) throw new Error('expected TerminalView to create its session socket');
    act(() => {
      socket.open();
      socket.emitServerMessage({ type: 'data', data: new TextEncoder().encode('A🙂é中Z') });
    });
    await waitFor(() =>
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('A🙂é中Z')
    );
    const line = term.buffer.active.getLine(0);
    expect(line?.getCell(1)?.getWidth(), 'expected emoji 🙂 to occupy two terminal cells').toBe(2);
    expect(term.unicode.activeVersion).toBe('11');
    expect(
      Array.from({ length: 7 }, (_, index) => {
        const cell = line?.getCell(index);
        return [cell?.getChars(), cell?.getWidth()];
      })
    ).toEqual([
      ['A', 1],
      ['🙂', 2],
      ['', 0],
      ['é', 1],
      ['中', 2],
      ['', 0],
      ['Z', 1],
    ]);
  } finally {
    capture.mockRestore();
  }
});
