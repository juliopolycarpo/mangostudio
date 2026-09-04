import type { Migration } from 'kysely/migration';

/**
 * Adds the per-chat external model choice: `runnerModel` and `runnerEffort`.
 *
 * A sibling of 046's permission columns and stored the same way — nullable
 * `TEXT`, nothing backfilled — but read on the **opposite** terms, and the
 * difference is the reason these are two columns rather than a reuse of that
 * pair's normaliser.
 *
 * 046's columns hold privileges, so an unrecognized value there resolves to the
 * restrictive end of its axis: there is always a safe answer, and substituting
 * it is safer than honouring a value this build does not understand. A model is
 * not a privilege and has no restrictive end. Its only sane fallback is the
 * vendor's own default, which is exactly what NULL already means, so an
 * unrecognized value here is **dropped** rather than substituted.
 *
 * Both hold vendor-minted ids, opaque to MangoStudio. Whether one still names a
 * model the vendor offers is decided at send time against a catalog that lives
 * on the runtime, not here; whether it is safe to put on a command line is
 * decided by the adapter that builds one. A NULL means "this chat has not
 * chosen", which is true of every chat that exists when this runs.
 */
export const chatRunnerModel: Migration = {
  async up(db): Promise<void> {
    await db.schema.alterTable('chats').addColumn('runnerModel', 'text').execute();
    await db.schema.alterTable('chats').addColumn('runnerEffort', 'text').execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('chats').dropColumn('runnerModel').execute();
    await db.schema.alterTable('chats').dropColumn('runnerEffort').execute();
  },
};
