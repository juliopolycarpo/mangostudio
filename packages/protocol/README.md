# @mangostudio/protocol

The TypeScript SDK for [Mango Protocol](https://github.com/juliopolycarpo/mango-protocol): one
JSON-Schema wire contract, inspired by JSON-RPC 2.0, that MangoStudio hubs, runtimes and tools
speak over stdio, local sockets, in-process ports and WebSocket. A Rust peer uses the
[`mango-protocol`](https://crates.io/crates/mango-protocol) crate and reads the same frames.

```sh
bun add @mangostudio/protocol
```

```ts
import Type from 'typebox';
import { Session, defineContract } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';

const files = defineContract({
  name: 'example.files',
  version: '1.0.0',
  methods: {
    'fs.read-file': {
      params: Type.Object({ path: Type.String() }),
      result: Type.Object({ text: Type.String() }),
    },
  },
});

const { a, b } = createInProcessPortPair();
const hub = new Session(a, { peer: { name: 'hub', version: '1.0.0', role: 'hub' } });
const runtime = new Session(b, { peer: { name: 'runtime', version: '1.0.0', role: 'runtime' } });

files.serve(runtime, { 'fs.read-file': async ({ path }) => ({ text: await Bun.file(path).text() }) });
const { text } = await files.client(hub).request('fs.read-file', { path: 'README.md' });
```

| Entry                                   | What                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `@mangostudio/protocol`                 | Frame schemas, codecs, `Session`, `defineContract`, errors, close codes |
| `@mangostudio/protocol/stdio`           | A child process speaking NDJSON on its own stdin and stdout             |
| `@mangostudio/protocol/spawn`           | Launch a child (or `ssh`) and talk to it over stdio                     |
| `@mangostudio/protocol/ipc`             | Unix domain sockets and Windows named pipes                             |
| `@mangostudio/protocol/ws`              | Chunked binary WebSocket, either side, browser-safe                     |
| `@mangostudio/protocol/in-process`      | Two ports in one process, for tests and embedding                       |
| `@mangostudio/protocol/testing`         | The conformance suite every transport passes                            |
| `@mangostudio/protocol/schema/1/*.json` | The normative JSON Schema files                                         |

The core entry is browser-safe. Guides live in the repository under `docs/`: building a
contract, adopting the SDK, conformance, versioning and releasing.

MIT.
