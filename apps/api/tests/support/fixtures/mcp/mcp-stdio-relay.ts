/**
 * stdio half of the MCP relay fixture: a runtime spawns this script as an ordinary stdio MCP
 * server, and it pipes every newline-delimited JSON-RPC message to the test process over a
 * loopback WebSocket, where a real SDK `Server` answers (see `mcp-relay-host.ts`). The script
 * holds no MCP logic and imports nothing, so it starts fast and any runtime — TypeScript or
 * Rust — sees exactly the stdio server the test defined.
 *
 * Lifecycle mirrors a real server: stdin EOF (the runtime closed the session) closes the socket,
 * and a socket closed by the test (its `Server` closed) exits the process, which the runtime
 * observes as the server going away.
 *
 * // Usage: spawned as `bun mcp-stdio-relay.ts ws://127.0.0.1:<port>/<route>`.
 */

const url = process.argv[2];
if (!url?.startsWith('ws://127.0.0.1:')) {
  process.stderr.write(
    `mcp-stdio-relay: expected a ws://127.0.0.1:<port>/<route> argument | received ${String(url)}\n`
  );
  process.exit(2);
}

function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

const socket = new WebSocket(url);
let pending = '';

socket.addEventListener('open', () => {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line.length > 0) socket.send(line);
      newline = pending.indexOf('\n');
    }
  });
  process.stdin.on('end', () => socket.close());
});
socket.addEventListener('message', (event) => {
  process.stdout.write(`${String(event.data)}\n`);
});
socket.addEventListener('close', () => exitAfterFlush(0));
socket.addEventListener('error', () => {
  process.stderr.write(
    `mcp-stdio-relay: expected a reachable relay host | received an error on ${url}\n`
  );
  exitAfterFlush(1);
});
