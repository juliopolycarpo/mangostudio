# Frontend Workspace Guidance

Read `../../AGENTS.md` first. This file only adds frontend-local entrypoints, invariants, and tests.

## Start Here

- App shell and router: `src/main.tsx`, `src/router.ts`, `src/routes/__root.tsx`
- Auth UI: `src/lib/auth-client.ts`, `src/routes/login.tsx`, `src/routes/signup.tsx`
- Feature routes: `src/routes/`
- Hooks and services: `src/hooks/`, `src/services/`
- UI system and layout: `src/components/ui/`, `src/components/layout/`, `src/index.css`
- API client: `src/lib/api-client.ts`

## Diagnose By Task

- Auth or session UX: `src/lib/auth-client.ts`, `src/routes/login.tsx`, `src/routes/signup.tsx`, `src/routes/_authenticated.tsx`, `tests/browser-smoke/auth-flow.spec.ts`
- Settings or model selection: `src/components/settings/`, `src/routes/_authenticated/settings/`, `src/hooks/use-model-catalog.ts`, and the matching API settings route
- Chat, gallery, or generation: `src/features/chat/ChatPage.tsx`, `src/components/ChatFeed.tsx`, `src/components/InputBar.tsx`, `src/components/GalleryPage.tsx`, `src/hooks/use-text-chat.ts`, `src/hooks/use-image-generation.ts`, `src/services/`
- App shell or routing: `src/routes/__root.tsx`, `src/routes/_authenticated.tsx`, `src/router.ts`, `src/main.tsx`

## Frontend Rules

- Keep using TanStack Router; do not introduce `react-router-dom`.
- Keep using Eden Treaty + TanStack Query for normal API access. Use direct `fetch` only in service modules when streaming, uploads, or browser-native APIs require it.
- Do not hardcode user-visible strings. Use `useI18n()` with keys from `apps/shared/src/i18n/pt-BR.ts` and `apps/shared/src/i18n/en.ts`.
- Prefer existing UI primitives in `src/components/ui/` before creating new ones.
- Keep business logic in hooks and services; routes and components should mostly compose them.
- Use the existing styling stack: Tailwind utilities plus tokens and helpers in `src/index.css`. Do not add CSS-in-JS or a second styling system.
- Do not edit `src/routeTree.gen.ts`; it is generated.

## Tests

- Unit or component: `bun run --filter @mangostudio/frontend test:unit`
- Integration: `bun run --filter @mangostudio/frontend test:integration`
- Coverage-sensitive work: `bun run --filter @mangostudio/frontend test:coverage`
- Use `apps/frontend/tests/support/mocks/create-fetch-scenario.ts` only for jsdom hook tests that must mock `fetch` behind Eden Treaty, not for API contract testing.
