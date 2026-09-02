import type { TerminalExit, TerminalNotice } from '@mangostudio/shared/terminal';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import { formatMessage } from '@/lib/i18n-format';
import { createAckAccounting } from './ack-accounting';
import { buildTerminalTheme, fontSizePx } from './terminal-theme';
import { type TerminalSocketStatus, useTerminalSocket } from './use-terminal-socket';

/** Dim-line SGR: readable as output, distinct from anything the shell prints. */
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function writeDimLine(term: Terminal, text: string): void {
  term.writeln(`${DIM}${text}${RESET}`);
}

export interface TerminalViewProps {
  readonly sessionId: string;
  readonly onStatusChange?: (status: TerminalSocketStatus | 'idle') => void;
  readonly onExit?: (exit: TerminalExit) => void;
  /** Test seams; production callers never pass these. */
  readonly createSocket?: (url: string) => WebSocket;
  readonly resolveUrl?: (sessionId: string) => string;
}

/**
 * Mounts one `@xterm/xterm` instance over one terminal session's socket.
 *
 * One socket per mounted view: switching sessions unmounts this and mounts a
 * fresh one, which detaches from the old session (the server keeps it running
 * and replays scrollback on the next attach) rather than holding two sockets
 * open for one browser tab.
 *
 * @example
 * <TerminalView sessionId={session.id} onExit={refetchSessions} />
 */
export function TerminalView({
  sessionId,
  onStatusChange,
  onExit,
  createSocket,
  resolveUrl,
}: TerminalViewProps) {
  const { t } = useI18n();
  const { resolvedTheme, config } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Read through refs so the mount effect — which creates one `Terminal` for
  // this component's whole lifetime — never depends on props that change
  // every render (`onExit`, `onStatusChange`) or on translated strings.
  const tRef = useRef(t);
  tRef.current = t;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const socket = useTerminalSocket({
    sessionId,
    createSocket,
    resolveUrl,
    onConnected: () => {
      // The server replays scrollback on every attach; without this a
      // reconnect would show it appended after whatever was on screen.
      termRef.current?.reset();
    },
    onData: (bytes) => {
      const term = termRef.current;
      if (!term) return;
      term.write(bytes, () => ackAccountingRef.current?.add(bytes.byteLength));
    },
    onExit: (exit) => {
      const term = termRef.current;
      if (term) {
        writeDimLine(
          term,
          exit.signal
            ? formatMessage(tRef.current.terminal.exitedBySignal, { signal: exit.signal })
            : formatMessage(tRef.current.terminal.exited, { code: String(exit.exitCode ?? 0) })
        );
      }
      onExitRef.current?.(exit);
    },
    onNotice: (notice: TerminalNotice) => {
      const term = termRef.current;
      if (!term) return;
      writeDimLine(term, noticeMessage(tRef.current, notice));
    },
  });
  const socketRef = useRef(socket);
  socketRef.current = socket;

  // Forwarded from an effect rather than from the hook's own callback: the
  // hook already tracks `status` as state, so this is the one place it needs
  // reporting outward to whatever renders the tab strip / unavailable line.
  useEffect(() => {
    onStatusChangeRef.current?.(socket.status);
  }, [socket.status]);

  // GONE (close code 4410) has no server-sent exit frame to render as a dim
  // line the way a normal process exit does — the session itself is gone, so
  // this is the one status the view has to narrate on its own.
  useEffect(() => {
    if (socket.status !== 'gone') return;
    const term = termRef.current;
    if (term) writeDimLine(term, tRef.current.terminal.disconnected);
  }, [socket.status]);

  const ackAccountingRef = useRef<ReturnType<typeof createAckAccounting> | null>(null);

  // Mounts one `Terminal` for this component's lifetime, reading `config` and
  // `resolvedTheme` once: `sessionId` changing remounts this component from
  // the caller's side (`key={sessionId}` on `TerminalView`), and the effects
  // below keep theme and font size live without forcing a remount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once by design; see comment above.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      // Matches `--font-mono` in index.css; xterm needs a literal font stack,
      // not a CSS custom property, to measure glyph cells correctly.
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: fontSizePx(config.fontSize),
      theme: buildTerminalTheme(resolvedTheme),
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());
    term.loadAddon(new Unicode11Addon());
    term.loadAddon(new ClipboardAddon());

    term.open(container);

    // WebGL is an optional accelerator: `happy-dom` and any browser without a
    // real GPU context have no `webgl2`, and a constructor throw there must
    // not take the whole terminal down with it — the DOM renderer is the
    // correct, working fallback, not a degraded one.
    if (canUseWebgl()) {
      void loadWebglAddon(term);
    }

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.onData((data) => socketRef.current.send(new TextEncoder().encode(data)));

    fitAndResize(term, fitAddon, socketRef.current);
    // JetBrains Mono is self-hosted; a mount before it finishes loading
    // measures cells against the fallback font and undersizes the grid.
    void document.fonts?.ready?.then(() => fitAndResize(term, fitAddon, socketRef.current));

    const resizeObserver = new ResizeObserver(() =>
      fitAndResize(term, fitAddon, socketRef.current)
    );
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    ackAccountingRef.current = createAckAccounting({
      onFlush: (bytes) => socketRef.current.acknowledge(bytes),
    });
    return () => ackAccountingRef.current?.dispose();
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = buildTerminalTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;
    term.options.fontSize = fontSizePx(config.fontSize);
    fitAndResize(term, fitAddon, socketRef.current);
  }, [config.fontSize]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={containerRef} className="h-full min-h-0 w-full" data-testid="terminal-view" />
      {socket.status === 'replaced' && (
        // `z-10`: xterm stacks its own layers (the link-layer canvas is z-index
        // 2) above a sibling overlay with no z-index, which leaves the button
        // visible but unclickable.
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface/90 p-6 text-center"
          data-testid="terminal-replaced-overlay"
        >
          <p className="text-sm text-on-surface-variant">{t.terminal.openInWindow}</p>
          <Button onClick={() => socket.reconnect()}>{t.terminal.takeOver}</Button>
        </div>
      )}
      {socket.status === 'reconnecting' && (
        <div className="absolute inset-x-0 top-0 z-10 flex justify-center p-2">
          <span className="rounded bg-surface/90 px-2 py-1 text-xs text-on-surface-variant">
            {t.terminal.reconnecting}
          </span>
        </div>
      )}
    </div>
  );
}

function noticeMessage(t: ReturnType<typeof useI18n>['t'], notice: TerminalNotice): string {
  switch (notice.kind) {
    case 'dropped':
      return formatMessage(t.terminal.dropped, { bytes: String(notice.bytes ?? 0) });
    case 'queue_overflow':
      return formatMessage(t.terminal.dropped, { bytes: String(notice.bytes ?? 0) });
    case 'runtime_disconnected':
      return t.terminal.runtimeDisconnected;
  }
}

function canUseWebgl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

async function loadWebglAddon(term: Terminal): Promise<void> {
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // The DOM renderer term.open() already installed is the fallback.
  }
}

/**
 * Fits the terminal to its container, then sends the result over the wire —
 * but only when it clears the wire's minimum size. A collapsed panel or a
 * hidden tab proposes dimensions below `TERMINAL_COLS_MIN`/`ROWS_MIN`, which
 * the server schema rejects outright.
 */
function fitAndResize(
  term: Terminal,
  fitAddon: FitAddon,
  socket: ReturnType<typeof useTerminalSocket>
): void {
  const proposed = fitAddon.proposeDimensions();
  if (!proposed || proposed.cols < 2 || proposed.rows < 1) return;
  fitAddon.fit();
  socket.resize(term.cols, term.rows);
}
