import {
  TERMINAL_COLS_MAX,
  TERMINAL_COLS_MIN,
  TERMINAL_ROWS_MAX,
  TERMINAL_ROWS_MIN,
  type TerminalExit,
  type TerminalNotice,
} from '@mangostudio/shared/terminal';
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
import { clampTerminalSize } from './terminal-fit';
import { buildTerminalTheme, fontSizePx } from './terminal-theme';
import { type TerminalSocketStatus, useTerminalSocket } from './use-terminal-socket';

/** Dim-line SGR: readable as output, distinct from anything the shell prints. */
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
/** One encoder for every keystroke: `onData` fires per key, and the instance is stateless. */
const keystrokeEncoder = new TextEncoder();

function writeDimLine(term: Terminal, text: string): void {
  term.writeln(`${DIM}${text}${RESET}`);
}

export interface TerminalViewProps {
  readonly sessionId: string;
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
export function TerminalView({ sessionId, onExit, createSocket, resolveUrl }: TerminalViewProps) {
  const { t } = useI18n();
  const { resolvedTheme, config } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Read through refs so the mount effect — which creates one `Terminal` for
  // this component's whole lifetime — never depends on props that change
  // every render (`onExit`) or on translated strings.
  const tRef = useRef(t);
  tRef.current = t;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const socket = useTerminalSocket({
    sessionId,
    createSocket,
    resolveUrl,
    onConnected: () => {
      // The server replays scrollback on every attach; without this a
      // reconnect would show it appended after whatever was on screen.
      termRef.current?.reset();
      // The mount-time fits ran while this socket was still `connecting`, and
      // a frame sent then is dropped rather than queued. This is the first
      // moment the PTY can be told the size the renderer is actually using —
      // `ResizeObserver` fires on container changes, not on socket open, so
      // nothing else retries and the shell would keep wrapping at the 80x24
      // it was opened with.
      const term = termRef.current;
      const fitAddon = fitAddonRef.current;
      if (term && fitAddon) fitAndResize(term, fitAddon, socketRef.current);
    },
    onData: (bytes) => {
      const term = termRef.current;
      if (!term) return;
      term.write(bytes, () => ackAccountingRef.current?.add(bytes.byteLength));
    },
    onExit: (exit) => {
      exitRenderedRef.current = true;
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

  // Every status the socket cannot come back from draws a dim line, or the
  // pane is a blank black rectangle with nothing to explain it — a pop-out on
  // a session the hub no longer holds closes with 4404 and used to render
  // exactly that. `replaced` is the exception: it has an overlay with the
  // action that recovers it. GONE (4410) follows a process exit, whose `exit`
  // frame already drew its own line, so only the second case narrates.
  useEffect(() => {
    if (socket.status === 'gone' && exitRenderedRef.current) return;
    const message = closedStatusMessage(tRef.current, socket.status);
    if (!message) return;
    const term = termRef.current;
    if (term) writeDimLine(term, message);
  }, [socket.status]);

  const ackAccountingRef = useRef<ReturnType<typeof createAckAccounting> | null>(null);
  const exitRenderedRef = useRef(false);

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
      // Mirrors the visible rows into an accessibility tree. With the WebGL
      // renderer the screen is one canvas and holds no text a screen reader,
      // or a browser test, can read; this is what makes the output reachable
      // by anything that is not a pair of eyes.
      screenReaderMode: true,
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

    term.onData((data) => socketRef.current.send(keystrokeEncoder.encode(data)));

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

/**
 * What to draw when the socket reaches a status it cannot leave on its own.
 * Null for the statuses that are still live (`connecting`, `open`,
 * `reconnecting`), the one the overlay already explains (`replaced`), and the
 * one that navigates away instead (`unauthorized`).
 *
 * @example
 * const message = closedStatusMessage(t, 'not-found'); // the session is gone
 */
function closedStatusMessage(
  t: ReturnType<typeof useI18n>['t'],
  status: TerminalSocketStatus
): string | null {
  switch (status) {
    case 'gone':
      return t.terminal.disconnected;
    case 'not-found':
      return t.terminal.notFound;
    case 'forbidden':
      return t.terminal.refused;
    default:
      return null;
  }
}

function noticeMessage(t: ReturnType<typeof useI18n>['t'], notice: TerminalNotice): string {
  switch (notice.kind) {
    // Which hop discarded the bytes is the relay's business, not the viewer's:
    // both read as a gap in the output, and both name how big it was.
    case 'dropped':
    case 'queue_overflow':
      return formatMessage(t.terminal.dropped, { bytes: String(notice.bytes ?? 0) });
    case 'runtime_disconnected':
      return t.terminal.runtimeDisconnected;
  }
}

/**
 * Answered once per page, and the probe context is released as soon as it has
 * answered. A browser caps how many live WebGL contexts a document may hold
 * (Chrome force-loses the *oldest* past ~16), so a probe left for the garbage
 * collector on every mount — and the rail remounts this view on every tab
 * switch — evicts the contexts the visible terminals are rendering with.
 */
let webglSupported: boolean | null = null;

function canUseWebgl(): boolean {
  if (webglSupported !== null) return webglSupported;
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2');
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    webglSupported = context !== null;
  } catch {
    webglSupported = false;
  }
  return webglSupported;
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
 * but only when it clears the wire's minimum size, and clamped to the wire's
 * maximum. A collapsed panel or a hidden tab proposes dimensions below
 * `TERMINAL_COLS_MIN`/`ROWS_MIN`, which the server schema rejects outright;
 * an ultrawide pop-out or a small font routinely proposes past
 * `TERMINAL_COLS_MAX`, which the schema also rejects, closing the socket.
 * `term.resize` (not `fitAddon.fit()`, which would resize to the unclamped
 * proposal) keeps the PTY size the renderer actually shows.
 */
function fitAndResize(
  term: Terminal,
  fitAddon: FitAddon,
  socket: ReturnType<typeof useTerminalSocket>
): void {
  const proposed = fitAddon.proposeDimensions();
  if (!proposed) return;
  const size = clampTerminalSize(proposed);
  if (!size) return;
  term.resize(size.cols, size.rows);
  socket.resize(term.cols, term.rows);
}
