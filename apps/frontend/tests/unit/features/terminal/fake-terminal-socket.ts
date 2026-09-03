import { encodeTerminalServerMessage } from '@mangostudio/shared/terminal';

/**
 * Named fake standing in for the browser `WebSocket` the terminal drives,
 * mirroring `realtime-client.test.ts`'s equivalent and shared by every terminal
 * test the way `fake-pty.ts` is shared in the runtime workspace.
 *
 * `send()` throws outside OPEN on purpose: that is what turns a frame sent
 * before the socket opened into a loud failure instead of a silently recorded
 * one. `drop()` fires a close the way a real transport would.
 *
 * @example
 * const socket = new FakeTerminalSocket(url);
 * socket.open();
 * socket.emitServerMessage({ type: 'exit', exitCode: 0, signal: null });
 */
export class FakeTerminalSocket {
  static instances: FakeTerminalSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeTerminalSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    if (this.readyState !== FakeTerminalSocket.OPEN) {
      throw new Error('InvalidStateError: socket is not open');
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeTerminalSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeTerminalSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitServerMessage(message: Parameters<typeof encodeTerminalServerMessage>[0]): void {
    const bytes = encodeTerminalServerMessage(message);
    this.onmessage?.({
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as MessageEvent);
  }

  drop(code: number): void {
    this.readyState = FakeTerminalSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}
