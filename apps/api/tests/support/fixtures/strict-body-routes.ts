/**
 * Inputs for `strict-body-contract.integration.test.ts`, which walks the real
 * route table. Keys are `METHOD /full/path/:pattern`, as Elysia lists a route.
 */

/**
 * A body valid for the route's schema, for the routes whose schema TypeBox
 * cannot create a value for (a pattern- or format-constrained string) or whose
 * minimal value is not valid (`minProperties`, a required nested choice).
 */
export const BASELINE_BODIES: Readonly<Record<string, unknown>> = {
  'POST /api/api-keys/': { name: 'contract', scope: 'full' },
  'POST /api/environments': {
    id: 'contract-env',
    name: 'Contract',
    transportKind: 'websocket',
    config: {},
  },
  'PUT /api/environments/:id': { enabled: true },
  'PUT /api/environments/:id/toolchain': { node: 'auto' },
  'POST /api/environments/:id/runtime/bootstrap': {
    ssh: { host: 'host.example.test' },
    consent: { profile: 'full' },
  },
  'POST /api/git/state/batch': { chatIds: ['chat-1'] },
  'POST /api/git/stage': { chatId: 'chat-1', paths: ['a.txt'] },
  'POST /api/git/unstage': { chatId: 'chat-1', paths: ['a.txt'] },
  'POST /api/git/discard': { chatId: 'chat-1', paths: ['a.txt'], mode: 'tracked' },
  'POST /api/git/commit': { chatId: 'chat-1', title: 'feat: contract' },
  'POST /api/library/propagate/undo': { backupId: 'backup-1' },
  'POST /api/mcp/servers': {
    name: 'Contract',
    slug: 'contract',
    transport: 'stdio',
    command: 'echo',
  },
  'POST /api/mcp/servers/portability/import/apply': {
    previewToken: 'a'.repeat(64),
    decisions: [{ key: 'k', decision: 'add' }],
  },
};

/**
 * Routes whose body is multipart form data (`t.File`). The contract test sends
 * JSON, which these do not parse, and their schemas are open objects: rc.4
 * ignored a stray form field here too.
 */
export const FORM_BODY_ROUTES: readonly string[] = [
  'POST /api/upload/',
  'POST /api/upload/chat',
  'POST /api/tool-identities/:subjectKey/image',
];

const OPEN_ROOT_REASON =
  'The body schema is an open root object, so an unknown top-level field was never an error here.';

/**
 * Routes whose JSON body schema has an open root object. Elysia rc.4 stripped an
 * unknown top-level field from these silently, and still does, so this is the
 * existing contract and not a regression. Closing one is a public API change:
 * make it deliberately, then delete the route from this list.
 *
 * The contract test fails when a route is missing here but open (a schema lost
 * its `additionalProperties: false`) and when a route is listed but closed.
 */
export const OPEN_BODY_ROUTES: Readonly<Record<string, { reason: string; routes: string[] }>> = {
  chats: {
    reason: OPEN_ROOT_REASON,
    routes: [
      'POST /api/chats/',
      'POST /api/chats/title-suggestion',
      'PUT /api/chats/:id',
      'POST /api/chats/:id/compact',
      'POST /api/chats/:id/summarize-to-new-chat',
      'POST /api/chats/:id/messages/:messageId/tool-calls/:callId/retry',
    ],
  },
  externalAgents: {
    reason: OPEN_ROOT_REASON,
    routes: [
      'DELETE /api/external-agents/workspace-trust',
      'POST /api/chats/:id/external-agent/respond',
      'POST /api/chats/:id/external-agent/steer',
      'POST /api/chats/:id/external-agent/review',
      'POST /api/chats/:id/external-agent/trust-workspace',
      'POST /api/chats/:id/fork-with-runner',
    ],
  },
  messagesAndGeneration: {
    reason: OPEN_ROOT_REASON,
    routes: [
      'POST /api/messages/',
      'PUT /api/messages/:id',
      'POST /api/generate',
      'POST /api/respond',
      'POST /api/respond/stream',
    ],
  },
  git: {
    reason: OPEN_ROOT_REASON,
    routes: [
      'DELETE /api/git/branches',
      'DELETE /api/git/worktrees',
      'POST /api/git/branches',
      'POST /api/git/branches/checkout-remote',
      'POST /api/git/branches/rename',
      'POST /api/git/branches/switch',
      'POST /api/git/commit',
      'POST /api/git/commit-message',
      'POST /api/git/discard',
      'POST /api/git/fetch',
      'POST /api/git/init',
      'POST /api/git/pull',
      'POST /api/git/push',
      'POST /api/git/stage',
      'POST /api/git/stash',
      'POST /api/git/stash/apply',
      'POST /api/git/stash/drop',
      'POST /api/git/stash/pop',
      'POST /api/git/state/batch',
      'POST /api/git/unstage',
      'POST /api/git/worktrees',
    ],
  },
  github: {
    reason: OPEN_ROOT_REASON,
    routes: ['POST /api/github/pr', 'POST /api/github/pr/checkout', 'POST /api/github/pr/ready'],
  },
  library: {
    reason: OPEN_ROOT_REASON,
    routes: [
      'POST /api/library/divergence/acks',
      'POST /api/library/propagate/apply',
      'POST /api/library/propagate/preview',
      'POST /api/library/propagate/undo',
      'POST /api/library/removal/apply',
      'POST /api/library/removal/preview',
    ],
  },
  mcp: {
    reason: OPEN_ROOT_REASON,
    routes: [
      'POST /api/mcp/elicitations/:id/respond',
      'POST /api/mcp/servers',
      'PUT /api/mcp/servers/:id',
      'POST /api/mcp/servers/:id/prompts/resolve',
      'POST /api/mcp/servers/:id/resources/read',
      'POST /api/mcp/servers/import',
      'POST /api/mcp/servers/import/preview',
      'POST /api/mcp/servers/portability/export',
      'POST /api/mcp/servers/portability/import/apply',
      'POST /api/mcp/servers/portability/import/preview',
    ],
  },
  settingsAndSkills: {
    reason: OPEN_ROOT_REASON,
    routes: [
      'POST /api/settings/agents',
      'POST /api/settings/agents/preview',
      'PUT /api/settings/agents/:agentId',
      'PUT /api/settings/app',
      'POST /api/settings/connectors',
      'POST /api/settings/connectors/:id/usage/reset',
      'PUT /api/settings/connectors/:id/models',
      'POST /api/settings/connectors/chatgpt/oauth/start',
      'POST /api/settings/connectors/gemini',
      'PUT /api/settings/connectors/gemini/:id/models',
      'PUT /api/settings/providers/:provider',
      'POST /api/settings/rule-files/preview',
      'PUT /api/skills/:skillKey',
    ],
  },
  workspaces: {
    reason: OPEN_ROOT_REASON,
    routes: ['POST /api/workspace/fs/validate'],
  },
};
