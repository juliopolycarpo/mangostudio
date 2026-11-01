import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs } from 'kysely';

/** Hold one completed SELECT, after Kysely releases its connection. */
export function holdFirstAppSettingsRead() {
  const read = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held: PluginTransformQueryArgs['queryId'] | undefined;
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (held === undefined && args.node.kind === 'SelectQueryNode') held = args.queryId;
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs) {
      if (args.queryId === held) {
        read.resolve();
        await release.promise;
      }
      return args.result;
    },
  };
  return { plugin, read: read.promise, release: () => release.resolve() };
}
