/**
 * Generates `spec/fixtures/1/catalog-example.json`: the `example.files`
 * contract shown in `docs/build-a-contract.md`, run through the real
 * `defineContract`/`.catalog()` pipeline so the fixture is exactly what a
 * peer publishing this contract would produce — not a hand-typed copy that
 * could drift from what TypeBox actually emits.
 *
 * Read back by both SDKs as a "same catalog document, both languages" check:
 * `Contract::from_catalog` in Rust, an equivalent assertion in
 * `contract.test.ts`.
 *
 * @example
 * bun ./scripts/fixtures/generate-catalog-example.ts          # rewrite the file
 * bun ./scripts/fixtures/generate-catalog-example.ts --check  # exit 1 when stale
 */

import { fileURLToPath } from 'node:url';
import Type from 'typebox';
import { defineContract } from '../../packages/protocol/src/contract';

const OUTPUT = new URL('../../spec/fixtures/1/catalog-example.json', import.meta.url);

const files = defineContract({
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
      payload: Type.Object({
        path: Type.String(),
        kind: Type.Union([Type.Literal('create'), Type.Literal('modify'), Type.Literal('delete')]),
      }),
      stream: true,
    },
  },
});

const document = files.catalog();
const text = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = await Bun.file(OUTPUT)
    .text()
    .catch(() => '');
  if (current !== text) {
    console.error(
      'spec/fixtures/1/catalog-example.json is stale; run bun ./scripts/fixtures/generate-catalog-example.ts'
    );
    process.exit(1);
  }
  console.log('catalog-example.json is up to date');
} else {
  await Bun.write(OUTPUT, text);
  console.log(
    `wrote ${fileURLToPath(OUTPUT)} (${document.methods.length} methods, ${document.events?.length ?? 0} events)`
  );
}
