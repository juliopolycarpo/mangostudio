import type { Migration } from 'kysely/migration';

/**
 * Which third-party disclosure each user has acknowledged, per vendor.
 *
 * A table rather than a settings key, because this row is a **precondition the
 * server enforces**, not a preference the client remembers. Settings are read
 * to render an interface; this is read to decide whether a turn may start at
 * all, on the external API path as well as the browser one. Those want different
 * guarantees: a settings blob is one JSON document written by read-modify-write,
 * so two concurrent saves can silently drop one acknowledgement, and nothing
 * about its shape stops a client from sending back a value it was never given.
 *
 * The primary key is `(userId, targetId)`. One acknowledgement per user per
 * vendor: agreeing to Anthropic's terms says nothing about OpenAI's, and a
 * single row for "external agents" would let one dialog stand in for three
 * different companies' obligations.
 *
 * `contextFingerprint` is what makes an acknowledgement go stale. It digests the
 * disclosure version, the vendor's declared capabilities and the resolved
 * effective permission default — so an agent that gains the ability to act
 * without asking, or an account whose default moves from "reads only" to
 * "everything with a classifier reviewing it", re-prompts instead of coasting on
 * consent given for something materially different.
 */
export const externalAgentDisclosures: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('external_agent_disclosures')
      .ifNotExists()
      .addColumn('userId', 'text', (col) => col.notNull())
      .addColumn('targetId', 'text', (col) => col.notNull())
      .addColumn('disclosureVersion', 'integer', (col) => col.notNull())
      .addColumn('contextFingerprint', 'text', (col) => col.notNull())
      .addColumn('acknowledgedAt', 'integer', (col) => col.notNull())
      .addPrimaryKeyConstraint('external_agent_disclosures_pk', ['userId', 'targetId'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('external_agent_disclosures').ifExists().execute();
  },
};
