# Documentation

This directory is organized by responsibility so contributors can find the
right depth quickly instead of scanning a flat list of files.

## Structure

| Folder          | Audience                     | Purpose                                                           |
| --------------- | ---------------------------- | ----------------------------------------------------------------- |
| `architecture/` | Maintainers, feature authors | System design, cross-cutting runtime behavior, and internal flows |
| `features/`     | Feature authors              | Behavior and implementation notes for product areas               |
| `providers/`    | Provider integrators         | Provider-specific notes and provider onboarding guides            |
| `reference/`    | Contributors, agents         | API surface, testing rules, and file-map navigation               |
| `guides/`       | New contributors             | Task-oriented onboarding and contributor workflows                |
| `operations/`   | Deployers, operators         | Deployment and security guidance                                  |
| `pt-br/`        | Portuguese readers           | Full Portuguese mirror of this documentation tree                 |

## Recommended Reading

### New contributor

1. [`../README.md`](../README.md)
2. [`guides/contributor-quickstart.md`](./guides/contributor-quickstart.md)
3. [`reference/testing.md`](./reference/testing.md)
4. [`reference/agent-playbooks.md`](./reference/agent-playbooks.md) when you need a feature map

### Backend or architecture work

1. [`architecture/overview.md`](./architecture/overview.md)
2. [`architecture/streaming.md`](./architecture/streaming.md)
3. [`architecture/continuation.md`](./architecture/continuation.md)
4. [`providers/development.md`](./providers/development.md)

### Product feature work

- [`features/settings.md`](./features/settings.md)
- [`features/tools.md`](./features/tools.md)
- [`features/attachments.md`](./features/attachments.md)
- [`features/image-generation.md`](./features/image-generation.md)

### Ops and deployment

- [`reference/cli.md`](./reference/cli.md)
- [`reference/releasing.md`](./reference/releasing.md)
- [`operations/deployment.md`](./operations/deployment.md)
- [`SECURITY.md`](../.github/SECURITY.md)

## Notes

- Root-level docs should stay limited to top-level entry points such as `README.md`, `.github/CONTRIBUTING.md`, and `AGENTS.md`.
- `docs/pt-br/` mirrors the same documentation structure in Brazilian Portuguese.
