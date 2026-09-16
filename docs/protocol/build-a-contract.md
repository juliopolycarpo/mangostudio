# Build a contract

The protocol carries frames; your application decides what the methods and events mean. A
contract is that decision written once, as TypeBox schemas, so both ends get typed calls,
parameter validation and a catalog document without writing a second copy.

## Define it

```ts
import Type from 'typebox';
import { defineContract } from '@mangostudio/protocol';

export const files = defineContract({
  name: 'example.files',
  version: '1.0.0',
  methods: {
    'fs.read-file': {
      params: Type.Object({ path: Type.String() }),
      result: Type.Object({ text: Type.String() }),
      capabilities: ['fs.read'],
      description: 'Reads a UTF-8 file inside the workspace.',
    },
    'fs.watch': {
      params: Type.Object({ path: Type.String() }),
      result: Type.Object({ streamId: Type.String() }),
    },
  },
  events: {
    'fs.changed': {
      payload: Type.Object({ path: Type.String(), kind: Type.Union([Type.Literal('create'), Type.Literal('modify'), Type.Literal('delete')]) }),
      stream: true,
    },
  },
});
```

Rules the definition enforces at load time:

- Method names and topics follow the wire grammar: lowercase dot-separated segments, at least
  two, no trailing dash, 128 characters at most. `rpc.` is reserved for the protocol.
- `params` and `result` are any TypeBox schema. Use `Type.Null()` for a method without a
  result; `Type.Object({})` for one without parameters.
- `capabilities` is a list of strings the application interprets. The SDK passes it to your
  guard and prints it in the catalog; it attaches no meaning to it.

## Serve it

```ts
import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';

const off = files.serve(session, {
  'fs.read-file': async ({ path }, context) => {
    const text = await readFile(resolveInsideWorkspace(path), { signal: context.signal });
    return { text };
  },
  'fs.watch': ({ path }, context) => startWatching(path, context.session),
}, {
  guard(method, capabilities, { params, inFlight, remote }) {
    if (!grants.allow(capabilities, remote.peer)) {
      audit.denied({ method, params, inFlight, peer: remote.peer.name });
      throw new RemoteError(RESERVED_ERROR_CODES.DENIED, `${method} needs ${capabilities.join(', ')}`, {
        kind: 'consent_denied',
      });
    }
  },
});
```

The guard runs *after* the parameters passed the method's schema and before the handler, so a
policy that logs, counts or audits a refusal is never handed a request the contract itself
refuses. Every handler receives parameters already validated against its schema; a bad request
never reaches your code, the peer gets `INVALID_PARAMS` with the failing JSON pointer in
`details.path`. `context.signal` aborts when the peer cancels or the session closes. A thrown
`RemoteError` reaches the peer with its code, message and details; any other exception becomes
`INTERNAL` with a generic message, so nothing you did not choose to say leaks.

`serve` returns the function that unregisters every handler.

## Call it

```ts
const client = files.client(session);
const { text } = await client.request('fs.read-file', { path: 'README.md' }, { timeoutMs: 5000 });
```

The parameter and result types come from the schemas. A failed call rejects with a
`RemoteError` carrying the peer's code; a local timeout cancels the request on the peer and
rejects with `TIMEOUT`; a session that closes mid-flight rejects with `UNAVAILABLE`.

## Emit and receive events

```ts
const events = files.events(session);

// Producer
events.emit('fs.changed', { path: 'a.ts', kind: 'modify' }, { streamId });
events.emit('fs.changed', { path: 'a.ts', kind: 'delete' }, { streamId, end: true });

// Consumer
const stop = events.on('fs.changed', (payload, frame) => {
  render(payload, frame.seq, frame.end === true);
});
```

Sequence numbers are per stream key (`streamId` when present, else the topic) and start at 0
again after `end`. `emit` returns `false` when the session is not ready, so a producer can
drop events for a peer that is gone without a try/catch.

## Publish the catalog

```ts
const catalog = files.catalog();
```

The catalog is a JSON document validated against `spec/schema/1/catalog.json`: every method
with its parameter and result schema, every event with its payload schema, the contract name
and version. Serve it from an HTTP route, print it in a CLI, or check it into a repository so
a peer in another language can generate types from it.

This exact `example.files` contract is committed as `spec/fixtures/1/catalog-example.json`,
generated from this document by `scripts/protocol/fixtures/generate-catalog-example.ts` — both the
TypeScript and Rust test suites read it back, so they test against one real, non-drifting
catalog.

## Version the contract

The contract `version` is yours. Announce it in `hello.capabilities` from both sides:

```ts
const session = new Session(port, {
  peer: { name: 'example-runtime', version: '2.3.0', role: 'runtime' },
  capabilities: { contracts: { [files.definition.name]: files.definition.version } },
});
```

A peer that finds a contract it cannot honour can close with `4403 FORBIDDEN` or answer every
call with `DENIED`; the protocol does not decide. Adding a method or an optional parameter is
a minor bump; renaming, removing or requiring more is a major one.
