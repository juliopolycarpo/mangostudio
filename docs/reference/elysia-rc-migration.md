# Elysia 2 RC migration

Reviewed against the [RC release notes](https://next.elysiajs.com/blog/elysia-20-rc/),
[beta foundation](https://next.elysiajs.com/blog/elysia-20), current official documentation,
and published packages on October 21, 2026.

## Versions and compatibility

| Package           | Previous        | Selected tag | Pinned version                   |
| ----------------- | --------------- | ------------ | -------------------------------- |
| `elysia`          | `2.0.0-beta.29` | `rc`         | `2.0.0-rc.0`                     |
| `@elysia/cors`    | `2.0.0-beta.1`  | `next`       | `2.0.0-beta.2`                   |
| `@elysia/openapi` | `2.0.0-beta.4`  | `next`       | `2.0.0-beta.6`                   |
| `@elysia/eden`    | `2.0.0-beta.6`  | `next`       | `2.0.0-beta.6` (already current) |

The plugin `next` tags still identify beta releases. Each plugin also has an RC tag;
this migration follows the requested `next` channel, which the
[OpenAPI installation guide](https://next.elysiajs.com/plugins/openapi/) still documents.
Versions are pinned rather than leaving moving tags in manifests. Registry metadata:
[core](https://registry.npmjs.org/elysia), [CORS](https://registry.npmjs.org/@elysia%2fcors),
[OpenAPI](https://registry.npmjs.org/@elysia%2fopenapi),
[Eden](https://registry.npmjs.org/@elysia%2feden).

RC restores `onRequest`, `onBeforeHandle`, and `onError` instance methods. Preserve
hook order, scopes, and class-specific error handlers when renaming them. `mapResponse`
and `derive` retain their names in the published RC API. Inline route options such as
`error` also retain their names.

The OpenAPI patch moves to beta.6. Without it, the application contract suite fails
both multipart binary-string documentation and the assertion that internal schema
markers never appear in the document. The existing route inventory, error schemas,
operation IDs, CORS policy, and listening WebSocket payload-cap tests cover the
combined application rather than just plugin construction.

## Opportunities and retained boundaries

| Capability                                                              | Application decision and evidence to require                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Error inference](https://next.elysiajs.com/patterns/error-handling/)   | Keep typed `status()` returns in auth, rate limiting, and error handlers. RC improves inference through hooks and macros. Future route work can return typed expected errors to improve Eden; arbitrary thrown errors such as `throwApiError` remain invisible to return-type inference.                                                               |
| [OpenAPI `fromTypes()`](https://next.elysiajs.com/patterns/openapi/)    | Potentially document otherwise missing success/error responses. This already existed before RC; runtime schemas take precedence. A trial needs monorepo root configuration and generated declarations available in bundled/binary deployments. Preserve schema-first public contracts.                                                                 |
| [Compression](https://next.elysiajs.com/plugins/compress/)              | Evaluate the new official plugin with opt-in routes (`default: false`) for large JSON responses. Frontend assets already use precompression. Verify SSE exclusion, encoded responses, ranges, cache headers, and secret-bearing responses before enabling it. No performance benefit is measured here.                                                 |
| [Build-time AOT](https://next.elysiajs.com/patterns/aot/)               | Reevaluate only with controlled startup, build, artifact-size, and memory measurements. AOT already existed in beta and executes the app during build; prove dry-run safety, identical registration, and binary boot. The beta.4 measurements in [tooling](./tooling.md#elysia-build-time-aot--evaluated-not-adopted) are historical, not RC evidence. |
| [SSE and generators](https://next.elysiajs.com/essential/handler/)      | Keep `sseResponse`: native `sse()` does not supply our heartbeat comments or `SSEErrorEvent` translation. Generator cancellation does not interrupt arbitrary awaited work; retain explicit abort propagation. These capabilities predate RC.                                                                                                          |
| [WebSockets](https://next.elysiajs.com/patterns/websocket/)             | Keep the existing transport plugin and shared payload limits. Realtime, runtime pairing, terminal, disconnect, and listening-server tests establish compatibility. Per-message schemas and generator replies are available for future protocol work; changing the protocol is unnecessary here.                                                        |
| [Macros](https://next.elysiajs.com/patterns/macro/)                     | Explicit macro types could help future route-option authorization macros. Existing named auth plugins already provide scope and deduplication; no conversion is needed for this migration.                                                                                                                                                             |
| [Eden extensions](https://next.elysiajs.com/eden/treaty/plugin/)        | Consider client extensions for custom verbs or mutation instrumentation. Mutation hooks exclude GETs and subscriptions, so retain the current fetcher for all-request Accept negotiation and 401 redirects.                                                                                                                                            |
| [Disposal and `defer`](https://next.elysiajs.com/essential/life-cycle/) | Existing beta and RC support derived request-owned disposable resources. Shared databases and runtime sessions retain application shutdown ownership. No current request resource has been identified for conversion.                                                                                                                                  |
| TypeBox and compiled responses                                          | Keep namespace injection for standalone binaries, file-type detector registration, eager/precompiled validation tests, and the compiled JSON response encoder. The published RC still uses a 16-request lazy compilation threshold; migration does not remove the reason for that encoder.                                                             |
| RFC 9457                                                                | Keep the existing negotiation boundary: routes return `ApiErrorResponse`, and negotiation renders problem details. Native `problem()` is not a replacement for this architecture. Existing error and spec-failure tests cover both negotiated and ordinary JSON responses.                                                                             |
| Other runtimes and validators                                           | Node adapters, alternate schema libraries, and the framework fullstack development server do not serve this Bun and TypeBox deployment. `t.Accelerate` for other schema libraries does not justify replacing shared schemas.                                                                                                                           |
| Upstream startup and memory improvements                                | RC may provide automatic benefits. No application performance claim follows from upstream measurements; qualify MangoStudio separately before claiming savings.                                                                                                                                                                                        |

The follow-up entries are evaluation opportunities, not newly discovered application defects
or features required to adopt RC. This migration does not enable them speculatively.
