import { dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Bundles a fixture while retaining each source module's import metadata.
 *
 * @example
 * const entry = await bundleShutdownFixture('/fixtures/entry.ts', tempDir);
 */
export async function bundleShutdownFixture(entry: string, outdir: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: 'bun',
    splitting: false,
    plugins: [
      {
        name: 'fixture-import-metadata',
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
            const extension = extname(path).replace(/^\.[cm]?/, '');
            const loader =
              extension === 'tsx' || extension === 'jsx' || extension === 'js' ? extension : 'ts';
            const transpiler = new Bun.Transpiler({
              loader,
              target: 'bun',
              define: {
                'import.meta.dir': JSON.stringify(dirname(path)),
                'import.meta.url': JSON.stringify(pathToFileURL(path).href),
                'import.meta.main': 'false',
              },
            });
            return {
              contents: transpiler.transformSync(await Bun.file(path).text()),
              loader: 'js',
            };
          });
        },
      },
    ],
  });
  if (!result.success || result.outputs.length !== 1 || !result.outputs[0]) {
    throw new Error(
      `Fixture bundle ${entry}: expected one successful output; received ${result.outputs.length} outputs.\n${result.logs.map((log) => log.message).join('\n')}`
    );
  }
  return result.outputs[0].path;
}
