# Agent Skills

Agent Skills package reusable instructions (and optional bundled files) that the model
loads on demand. MangoStudio advertises the installed skills to the model as a short list;
the full instructions only enter the context window when the model asks for them through the
`skill` tool. This keeps the per-turn token cost bounded no matter how many skills are
installed.

## Skill format

A skill is a directory whose name is the skill **slug**, containing a `SKILL.md` file:

```text
<skills-dir>/
  pdf-tools/
    SKILL.md
    reference.md
    scripts/
      fill-form.sh
```

`SKILL.md` starts with YAML frontmatter and is followed by the instruction body:

```markdown
---
name: pdf-tools
description: Work with PDF files — extract text, fill forms, and merge pages.
---

# PDF instructions

Steps the model should follow… Reference `reference.md` and run `scripts/fill-form.sh`.
```

Rules enforced by discovery (`apps/api/src/modules/skills/application/skill-discovery.ts`):

- The slug matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 64 characters.
- Frontmatter `name` **must equal** the directory slug.
- Frontmatter `description` must be a non-empty string; it is what the model sees when
  deciding whether to load the skill.
- `SKILL.md` must be a regular file no larger than 256 KiB.

A skill that violates any rule is still listed (so the Settings UI can show why) but is
marked invalid: it is never advertised to the model and cannot be loaded.

## Sources and precedence

Skills are discovered from up to three source directories, in precedence order:

| Source   | Directory                                      | Default   |
| -------- | ---------------------------------------------- | --------- |
| `mango`  | `[skills] dir` (defaults to `~/.mango/skills`) | always on |
| `agents` | `~/.agents/skills`                             | off       |
| `claude` | `~/.claude/skills`                             | off       |

Set the `mango` directory with the `[skills] dir` entry in `.mango/config.toml` (see
`.mango/config.toml.example`); an empty value auto-detects `~/.mango/skills`. The two
third-party directories were written for other agents, so they are opt-in per user via the
source toggles on the Skills settings page.

Each skill has a stable identity of `<source>:<slug>` (e.g. `mango:pdf-tools`). When the same
slug exists in more than one enabled source, the higher-precedence source wins and the others
are **shadowed** — hidden from the model and reported as shadowed in settings. A shadowed copy
stays shadowed even if the winner is disabled or invalid, so precedence never silently flips
with a toggle.

## Lazy-load mechanics

1. **Advertisement.** When the `skill` tool is available to the agent and at least one usable
   skill exists, the turn appends an `<available-skills>` section to the system prompt listing
   each usable skill as `- <name> — <description>`
   (`apps/api/src/modules/skills/application/skills-prompt-section.ts`). Only valid, enabled,
   non-shadowed skills appear.
2. **Load body.** The model calls the `skill` tool with `{ "name": "<skill>" }`. The tool
   returns the `SKILL.md` body (frontmatter stripped), the skill's absolute `baseDir`, and a
   listing of the bundled files (`apps/api/src/services/tools/builtin/skill.ts`).
3. **Load a bundled file.** The model calls `skill` again with
   `{ "name": "<skill>", "file": "reference.md" }` to pull one bundled resource into context.
4. **Run a bundled script.** Because the body returns `baseDir`, the model can run a bundled
   script with a shell tool (`bash`, `zsh`, or `powershell`) against that directory — the shell
   tools are opt-in and must be enabled in Tool settings.

File reads are strictly confined to the skill directory: absolute paths, `..` traversal, and
symlinks that resolve outside the directory are rejected
(`apps/api/src/modules/skills/application/skill-content.ts`). Oversized files are truncated at
256 KiB with a `truncated` flag; the bundled-file listing is bounded to 100 files and three
directory levels deep.

## Settings

The Skills settings page (`apps/frontend/src/features/settings/skills/`) lists every discovered
skill with its source, validity, and shadow state, and lets each user:

- toggle the `agents` and `claude` source directories on or off, and
- enable or disable individual skills.

Both are per-user and persisted (`skill_settings` and app settings). Discovery memoizes the
filesystem scan for a short interval, but user toggles are read fresh on every turn, so a
change takes effect on the next turn.

## Troubleshooting

- **A skill is not offered to the model.** Confirm it is valid (frontmatter `name` equals the
  directory slug and `description` is non-empty), enabled, and not shadowed by a
  higher-precedence source. Invalid and shadowed skills are shown with a reason on the settings
  page.
- **`Frontmatter "name" must match the skill directory name`.** Rename either the directory or
  the `name` field so they are identical.
- **A third-party skill is missing.** The `agents` and `claude` sources are off by default;
  enable the source toggle. A missing source directory simply yields no skills — it is not an
  error.
- **`Skill "<name>" is disabled in settings`.** The skill exists and is valid but was disabled
  for this user; re-enable it on the settings page.
- **Two skills with the same slug.** Only the higher-precedence one (`mango` > `agents` >
  `claude`) is usable; rename one slug to surface both.
