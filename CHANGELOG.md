# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com), and this
project adheres to [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-05-29

### 🚀 Features

- **(cli)** Add @mangostudio/cli npm wrapper package
- **(tools)** Add grep, glob and shell built-in tools (#256)
- **(api,frontend,shared)** Add subagent delegation and lifecycle (#237)
- **(generation)** Resolve selected agent runtime (#236)
- **(chat)** Add chat agent mode switch with persistence (#235)
- **(frontend)** Add agent settings UI with UX polish (#234)
- **(api)** Add agent settings API and storage (#233)
- **(shared)** Add agent domain contracts (#232)
- **(api)** Provider keepalive, observability, and routing cache (#225)
- **(frontend)** Improve mobile layout and add settings autosave (#219)
- **(tools)** Add read_file and list_directory builtin tools (#218)
- **(chat)** Auto-rename new chats from user prompts (#217)
- **(settings)** Persist app settings via API and database (#210)
- **(providers)** Deliver chat attachments to provider agents (#203)
- **(attachments)** Add chat attachment upload and turn linking (#202)
- **(tools)** Add catalog-backed image model selector (#200)
- **(chat)** Add image tool chat intent and image generation button (#198)
- **(tools)** Add image generation tool backend (#197)
- **(images)** Persist generated image artifacts (#196)
- **(images)** Separate generated image storage from uploads (#189)
- **(studio)** Add placeholder route for image workspace (#188)
- **(settings)** Add dedicated tools settings page (#187)
- **(settings)** Add global tool settings backend (#186)
- **(generation)** Apply prompt rule composition in generation (#185)
- **(settings)** Add rule file resolver and routes (#184)
- **(settings)** Add dedicated prompt settings page (#183)
- **(settings)** Add per-provider settings pages (#182)
- **(settings)** Persist provider runtime settings (#181)
- **(deepseek)** Add agent stream with turn-local continuation (#180)
- **(providers)** Add DeepSeek provider via AI SDK (#179)
- **(chat)** Add context compaction settings flow (#170)
- **(chat)** Add continuation transition timeline events (#169)
- **(api)** Add continuation runtime decision engine (#154)
- **(api)** Add structured output support and capability flags for providers
- **(api)** Add strict tool schema support and stateful compaction for OpenAI Responses
- **(frontend)** Add code theme selector with more Shiki themes
- **(frontend)** Add light theme support with system preference resolution
- **(frontend)** Add appearance settings page
- **(frontend)** Add chat feed UX polish copy, scroll, timestamps, skeletons, suggestion chips
- **(frontend)** Add copy-to-clipboard button on fenced code blocks
- **(frontend)** Integrate Shiki syntax highlighting for markdown code blocks
- **(frontend)** Markdown rendering and safe link features for chat page (#62)
- **(frontend, chats)** Enhance context handling and i18n support
- **(api)** Normalize reasoning, align capabilities, and improve context policy
- **(api)** Structured replay builder; add continuation_degraded handling and provider fallback fixes
- **(api)** Structured replay builder for OpenAI, Gemini, and OpenAI-compatible providers
- **(providers)** Context estimation UI and provider fallback
- **(providers)** Introduce ContinuationEnvelope and expand ModelCapabilities
- **(api)** Advanced agentic flows with Gemini Interactions and prompt caching (#52)
- **(ui)** Update AI disclaimer string and use i18n
- Introduce tool calling and agentic orchestration
- **(frontend)** Modernized model selector and reasoning toggle aesthetics
- **(OpenAI, Anthropic)** Add support for reasoning models and extended thinking (#45)
- **(gemini)** Implement support for model thinking process and structured message parts
- **(api, shared)** Implement structured message parts and provider state persistence
- **(frontend)** Add model searchbar to connector config
- **(connectors)** Split openai and openai-compatible providers (#37)
- **(logo, docs)** Adopt optimized WebP logo and refresh documentation
- **(logo)** Add svg logo
- **(settings)** Replace inline connector deletion with a confirmation
- **(api,frontend)** Add multi-provider AI support (OpenAI, Anthropic, Gemini) (#24)
- **(api,frontend)** Add SSE streaming for text generation (#23)

### 🐛 Bug Fixes

- **(deepseek)** Align reasoningEffort type with AI SDK union
- **(frontend)** Enable Biome a11y rules and fix violations (#242)
- **(api)** Persist replay context state independently (#163)
- **(api)** Harden Gemini continuation
- **(api)** Restore Gemini reasoning config for Interactions and text streams
- **(api)** Account stateless-loop turn-local payload in context estimation
- **(generation)** Expose max tool iterations and guard against loop exhaustion
- **(streaming)** Harden continuation and replay consistency across providers
- **(frontend)** Enhance message persistence and rendering for thinking segments
- **(models)** Fix continuation contracts and respond-stream
- **(frontend)** Fix gemini reasoning detection and design improvements
- **(api)** Await gemini catalog refresh on cold start
- **(api)** Improve OpenAI image generation support
- **(api, shared)** Fix image model recognition
- **(connectors)** Polish connector UX and image provider support
- **(api, frontend)** Model bootstrap, stream cancellation, and cache bounds
- **(test)** Fix test bootstrap by establishing canonical migration registry
- **(api,frontend)** Critical bug fixes, auth, race condition, rate-limiter, double-submit
- **(frontend)** Prevent InputBar from overlapping chat messages
- **(spa)** Auth routing login conflict (#21)
- **(frontend)** Fixed runtime builds api origin and unit test for base api url (#19)
- **(api)** Include server origin in CORS and trustedOrigins (#18)
- **(build)** Guard chmod behind POSIX platform check (#17)
- **(binary)** Serve frontend correctly from compiled binary and add binary smoke test workflow (#16)
- **(binary)** Multiple fixes for binary builds and regression tests (#13)
- **(config)** Using repo root for relative paths (#11)
- **(deps)** Align elysia to 1.4.x and fix Eden Treaty TypeScript errors
- **(auth)** Add session guard and fix login race condition
- **(test)** Fix test suite authentication and isolation errors

### 🧹 Miscellaneous

- **(meta)** Add repository metadata and install docs
- **(ci)** Bump actions/download-artifact from 5 to 8 (#239)
- **(tooling)** Improve agent and editor experience (#244)
- **(docs)** Restructure docs and create pt-br mirror (#216)
- **(ci)** Bump actions/upload-artifact from 4 to 7
- **(ci)** Bump actions/cache from 4 to 5
- **(dx)** Improve CI workflow feedback and local validation support
- **(frontend)** Migrate React linting to ESLint 10 and @eslint-react
- **(ci)** Bump actions/upload-artifact from 4 to 7
- **(ci)** Bump actions/checkout from 4 to 6
- **(ci)** Fix Dependabot schedule schema (#88)
- **(ci)** Add Dependabot config and remove PR commit automation
- **(test)** Add integration and unit tests for chat, messages, upload, and optimistic UI hooks
- **(docs)** Update README with new banner
- **(config)** Standardize ci, scripts, and repository configuration
- Add .editorconfig and .gitattributes
- **(licence)** Add MIT license (#12)
- **(docs)** Add commit template and pt-BR contributing guide
- **(github)** Add extended issue templates (question, migration, config)
- **(github)** Add repository templates and contributing guide

### ◀️ Revert

- **(deepseek)** Restore reasoningEffort intersection workaround

### ⚡ Performance

- **(ci)** Cache vite optimizer and deduplicate test passes (#246)
- **(api)** Add top-level Anthropic automatic prompt caching

### ♻️ Refactor

- **(scripts)** Split qa-gate render into section renderers
- **(scripts)** Split qa-gate collect into focused collectors
- **(scripts)** Use Bun-native fs removal in clean
- **(scripts)** Replace execSync git helpers with Bun.spawnSync
- **(scripts)** Split runner into focused lib modules
- **(config)** Reorganize agent config and simplify LSP tooling (#251)
- **(css)** Extract markdown styles and fix specificity (#243)
- **(tooling)** Migrate lint/format to biome and add QA gate (#238)
- **(api)** Remove deprecated provider re-export wrappers (#201)
- **(chat)** Remove legacy image mode from main composer (#199)
- **(api)** Add structured continuation logger (#178)
- **(api)** Add provider contract assertions and state split (#173)
- **(api)** Centralize OpenAI responses create params (#156)
- **(api)** Route turn state via continuation runtime (#155)
- **(type-safety)** Harden runtime types and eliminate unsafe casts across API and frontend
- **(frontend)** Restructure into feature modules, add i18n coverage, and adopt TanStack Router loaders
- **(api)** Decompose providers into bounded-context modules and migrate gemini legacy paths
- **(api)** Extract chat, messages, and generation into bounded-context modules
- **(api)** Extract connectors into bounded-context module
- **(shared)** Introduce bounded-context TypeBox schemas and migrate API/frontend to shared contracts
- **(scripts)** Consolidate dev tooling into unified bun task runner
- **(eslint)** Enhance linting rules and refactor for improved code quality
- **(api,frontend)** Strengthen chat streaming and validation flow
- **(models)** Refine API safety and better Claude model handling
- **(chore)** Enhance type safety and enforce strict linting rules
- **(config)** Standardize agent documentation, scripts, and linting
- **(frontend)** Split settings route and retire legacy frontend
- **(frontend, api)** Using Eden Treaty client instead of vanilla fetch
- **(api)** Improve type safety and optimizations
- **(api)** Decouple AI provider abstraction from Gemini (#22)
- **(config)** Centralize all enviroment logic to a single config.toml (#10)

### 🔒 Security

- **(deps)** Pin @tanstack/react-router to known-good versions (#231)
- **(test)** Harden Connectors Against SSRF, Shared Mutation, and Rate-Limit Bypass

### 📚 Documentation

- **(scripts)** Add scripts architecture and releasing guides
- **(continuation)** Add architecture and provider dev guide (#172)
- **(chore)** Improve repository guidelines for LLM agents

### 🧪 Testing

- Migrate to bun:test, expand coverage, harden qa gate (#245)
- **(api)** Add provider fake factories for tests (#171)
- **(e2e)** Add Playwright Chromium auth smoke suite (#34)

### ⬆️ Dependencies

- **(deps)** Bump @tanstack/react-query from 5.100.9 to 5.100.14 (#255)
- **(deps)** Bump @types/react (#252)
- **(deps)** Bump @tanstack/react-router from 1.169.2 to 1.170.8 (#254)
- **(deps)** Bump the vitest group with 3 updates (#253)
- **(deps)** Bump @tanstack/router-devtools from 1.166.13 to 1.167.0 (#250)
- **(deps)** Bump ai from 6.0.177 to 6.0.191 (#248)
- **(deps)** Bump better-auth from 1.6.10 to 1.6.11 (#249)
- **(deps)** Bump vite from 8.0.12 to 8.0.13 (#247)
- **(deps)** Bump @playwright/test (#228)
- **(deps)** Bump the vitest group across 1 directory with 3 updates (#227)
- **(deps)** Bump tailwind-merge from 3.5.0 to 3.6.0 (#229)
- **(deps)** Bump @types/bun in the typescript group across 1 directory (#240)
- **(deps)** Bump kysely from 0.28.17 to 0.29.0 (#220)
- **(deps)** Bump better-auth from 1.6.9 to 1.6.10 (#224)
- **(deps)** Bump tailwindcss from 4.2.4 to 4.3.0 (#222)
- **(deps)** Bump ai from 6.0.175 to 6.0.177 (#223)
- **(deps)** Bump vite from 8.0.11 to 8.0.12 (#221)
- **(deps)** Bump @tanstack/react-router from 1.169.1 to 1.169.2 (#214)
- **(deps)** Bump @ai-sdk/openai-compatible from 2.0.46 to 2.0.47 (#213)
- **(deps)** Bump vite from 8.0.10 to 8.0.11 (#212)
- **(deps)** Bump @anthropic-ai/sdk from 0.95.0 to 0.95.1 (#211)
- **(deps)** Bump @google/genai from 1.51.0 to 1.52.0 (#215)
- **(deps)** Bump react and react-dom to 19.2.6 (#209)
- **(deps)** Bump @ai-sdk/openai-compatible from 2.0.45 to 2.0.46 (#205)
- **(deps)** Bump @anthropic-ai/sdk from 0.92.0 to 0.95.0 (#206)
- **(deps)** Bump ai from 6.0.174 to 6.0.175 (#204)
- **(deps)** Bump the eslint group across 1 directory with 2 updates (#195)
- **(deps)** Bump @tanstack/router-plugin from 1.167.31 to 1.167.32 (#194)
- **(deps)** Bump @tanstack/react-query from 5.100.6 to 5.100.9 (#191)
- **(deps)** Bump kysely from 0.28.16 to 0.28.17 (#192)
- **(deps)** Bump marked from 18.0.2 to 18.0.3 (#193)
- **(deps)** Bump @tanstack/router-plugin from 1.167.29 to 1.167.31
- **(deps)** Bump @tanstack/react-router from 1.168.26 to 1.169.1
- **(deps)** Bump @anthropic-ai/sdk from 0.91.1 to 0.92.0
- **(deps)** Bump jsdom from 29.1.0 to 29.1.1
- **(deps)** Bump @tanstack/router-plugin from 1.167.28 to 1.167.29
- **(deps)** Bump @tanstack/react-router from 1.168.25 to 1.168.26
- **(deps)** Bump lucide-react from 1.11.0 to 1.14.0
- **(deps)** Bump openai from 6.34.0 to 6.35.0
- **(deps)** Bump @google/genai from 1.50.1 to 1.51.0
- **(deps)** Bump @tanstack/react-query from 5.100.5 to 5.100.6
- **(deps)** Bump @tanstack/router-plugin from 1.167.22 to 1.167.28
- **(deps)** Bump jsdom from 29.0.2 to 29.1.0
- **(deps)** Bump @elysiajs/cors from 1.4.1 to 1.4.2
- **(deps)** Bump better-auth from 1.6.7 to 1.6.9
- **(deps)** Bump typescript-eslint in the eslint group
- **(deps)** Bump @tanstack/react-query from 5.100.1 to 5.100.5
- **(deps)** Bump @tanstack/react-router from 1.168.23 to 1.168.25
- **(deps)** Bump @elysiajs/openapi from 1.4.14 to 1.4.15
- **(deps)** Bump lucide-react from 1.9.0 to 1.11.0
- **(deps)** Bump @tanstack/react-virtual from 3.13.23 to 3.13.24
- **(deps)** Bump @anthropic-ai/sdk from 0.90.0 to 0.91.1
- **(deps)** Bump lucide-react from 1.8.0 to 1.9.0
- **(deps)** Bump @elysiajs/static from 1.4.9 to 1.4.10
- **(deps)** Bump @tanstack/react-query from 5.99.2 to 5.100.1
- **(deps)** Bump vite from 8.0.9 to 8.0.10
- **(deps)** Bump better-auth from 1.6.6 to 1.6.7
- **(deps)** Bump @types/bun in the typescript group
- **(deps)** Bump @tailwindcss/vite from 4.2.2 to 4.2.4
- **(deps)** Bump the vitest group with 3 updates
- **(deps)** Bump vite from 8.0.8 to 8.0.9
- **(deps)** Bump better-auth from 1.6.5 to 1.6.6
- **(deps)** Bump typescript-eslint from 8.58.2 to 8.59.0 in the eslint group (#135)
- **(deps)** Bump file-type from 21.3.4 to 22.0.1
- **(deps)** Bump @tanstack/react-query from 5.99.0 to 5.99.2
- **(deps)** Bump lefthook from 2.1.5 to 2.1.6
- **(deps)** Bump @tanstack/router-plugin from 1.167.12 to 1.167.22
- **(deps)** Bump better-auth from 1.6.4 to 1.6.5
- **(deps)** Bump @tanstack/react-router from 1.168.10 to 1.168.23
- **(deps)** Bump marked from 18.0.0 to 18.0.2
- **(deps)** Bump the eslint group across 1 directory with 2 updates (#125)
- **(deps)** Bump lucide-react from 0.546.0 to 1.8.0
- **(deps)** Bump @tanstack/react-query from 5.96.1 to 5.99.0
- **(deps)** Bump typescript from 6.0.2 to 6.0.3 in the typescript group
- **(deps)** Bump @anthropic-ai/sdk from 0.88.0 to 0.90.0
- **(deps)** Upgrade vite from 8.0.0 to version 8.0.8
- **(deps)** Upgrade react and react-dom to version 19.2.5
- **(deps)** Bump kysely from 0.27.6 to 0.28.16
- **(deps)** Bump @vitejs/plugin-react from 5.2.0 to 6.0.1
- **(deps)** Bump @elysiajs/static from 1.4.7 to 1.4.9
- **(deps)** Bump marked from 17.0.5 to 18.0.0
- **(deps)** Bump openai from 6.33.0 to 6.34.0
- **(deps)** Bump prettier from 3.8.1 to 3.8.3
- **(deps)** Bump better-auth from 1.5.6 to 1.6.3
- **(deps)** Bump @tanstack/router-devtools from 1.166.11 to 1.166.13
- **(deps)** Bump jsdom from 29.0.1 to 29.0.2
- **(deps)** Bump @google/genai from 1.48.0 to 1.50.1
- **(deps)** Bump the typescript group with 2 updates
- **(deps)** Bump the vitest group with 3 updates
- **(deps)** Bump @anthropic-ai/sdk from 0.80.0 to 0.88.0
- **(deps)** Bump kysely-bun-sqlite from 0.3.2 to 0.4.0

### 👷 CI

- **(release)** Add release pipeline for binaries, npm, and GitHub release
- Normalize cache versions and extract shared vite cache action
- **(changelog)** Add PR changelog preview bot
- **(changelog)** Add git-cliff config and changelog wrapper
- **(actions)** Add reusable setup-mango composite action and cache layers
- **(workflows)** Harden workflows and stabilize auth/logout smoke tests
- **(template)** Automate pull request template with branch commits
- **(github)** Add GitHub Actions CI workflows

