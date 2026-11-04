# Product operation identity

`POST /api/chats`, `POST /api/respond` and `POST /api/respond/stream` accept an
optional `operationId`: 1–128 ASCII letters, digits, `_` or `-`. Callers generate
and persist it before sending. Omitting it preserves the existing synchronous
chat/turn and SSE contracts.

## Admission and result recovery

The key is scoped to the authenticated user across operation kinds. A unique
SQLite `(userId, operationId)` constraint commits admission before dispatch.
A SHA-256 fingerprint includes the kind and canonical request fields; turn
admission also binds the persisted runner, environment and workdir, with stream
permissions/model selection. Property order does not change the fingerprint;
changing input, operation kind, or turn transport returns typed HTTP 409. Equal
text with a new key remains a new request. Keys belonging to another user never
reveal a receipt or prevent that user from using the same opaque key.

Chat creation and its completed receipt commit in one transaction. Replaying
returns the original chat snapshot. A deleted or no-longer-owned chat returns
404, without recreating it. Activity is published only for the winning create.

Opting into a turn operation returns JSON `OperationReceipt`, including on the
`/respond/stream` endpoint; it does not return an SSE body. The hub consumes its
existing runner stream independently of the requesting browser. The initial
receipt can be accepted or running. Replaying returns the current receipt
without dispatching again. `GET /api/operations/:operationId` returns the same
owner-authorized receipt; its `chatId` and completed `messageId` address the
persisted result through the existing chat transcript endpoint. Errors use the
shared API error shape. Missing/foreign/deleted-chat receipts return 404.

States are `accepted`, `running`, `completed`, `failed`, and `unresolved`.
Acceptance means the hub reserved the logical request, not that a vendor
performed an external effect. A stream's explicit terminal error records failed;
EOF alone never proves completion. Stream preflight refusals release the
reservation because no execution started, allowing consent/model correction with
the same ID. A keyed non-streaming request is admitted before its application
preflight; refusal becomes a failed receipt. Ordinary keyless preflight behavior
is unchanged.

The process ownership nonce changes on restart. Accepted/running rows from a
predecessor become unresolved on lookup/replay and remain reserved. A crash
between dispatch, message persistence and terminal receipt cannot prove remote
execution, so the hub never automatically resubmits. An explicit new operation
is available after inspecting the chat. This is hub admission idempotency; it
makes no exactly-once claim about provider or vendor effects. Multiple hub
processes concurrently serving the same database are not a supported recovery
ownership model: a foreign process owner is treated as uncertain.

## Migration and retention

Migration `060_product_operations` adds one table and its expiry index. The
primary key reserves each user/key; the user foreign key cascades on account
deletion. Chat IDs are deliberately not cascading foreign keys: deleting a chat
must not make an old key eligible to create it again. The down migration drops
the table and loses its reservations; restoring a pre-migration database also
loses those guarantees. No migration is run against a live database by this PR.

The receipt/result recovery window is seven days from initial admission, never
extended by replay. Expired lookup or replay returns typed 410 and never admits
the key again. Minimal identity/fingerprint tombstones remain until account
deletion. Expired chat-result snapshots are cleared on lookup and opportunistically
on a new claim; clearing is lazy, not a timed deletion guarantee. Turn text and
provider secrets are not stored in this table; ordinary transcripts keep their
own existing retention policy.

## First-run client

Profile onboarding state stores creation ID/title and turn ID/prompt before
network side effects. It reuses freshly read identities when another surface
already stored them. Lost acknowledgements recover via the receipt; transcript
text is never an admission predicate. Only a completed operation's own assistant
message satisfies the answer fact. Legacy records without IDs retain transcript
completion compatibility.

A failed or unresolved operation offers an explicit new-request action. That
clears the turn ID while retaining the chat. A running operation cannot be
replaced through that action. The receipt query polls only accepted/running work
while the surface is visible. Failed recovery/expiry shows uncertainty and an
escape to the chat instead of an indefinite waiting claim.
