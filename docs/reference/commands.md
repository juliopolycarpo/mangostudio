# Slash commands

A native MangoStudio chat has its own slash commands: markdown files in
`~/.mango/commands` that the user invokes by name. Where a skill is advertised to the
model and loaded when the model decides to, a command runs when the user types it.

## Format

One file per command. The file stem is the command name, and the optional frontmatter
carries what the `/` palette shows:

```markdown
---
description: Review a file for bugs
---

Review $1 and list anything that looks wrong. Everything I typed: $ARGUMENTS
```

The directory is `commands` under the MangoStudio config home (`~/.mango`, or wherever
`MANGOSTUDIO_CONFIG_HOME` points). It is the `mango-commands` library location, so the
Library matrix lists these files, and propagation copies them to and from the vendor
command directories (`~/.claude/commands`, `~/.codex/prompts`, `~/.cursor/commands`)
byte for byte.

## Invoking

Typing `/` at the start of a message opens the palette; it lists these commands next to
the user's skills. When a message starts with `/name` and `name` is one of these files,
the hub replaces the message with the template before the model sees it. The transcript
keeps what the user typed. The expansion is stored beside the message (`messages.expandedText`,
never returned to clients), so later turns replay what the model acted on rather than the
bare `/name args`. A message stored before that column existed replays as typed.

| Placeholder  | Replaced with                                                     |
| ------------ | ----------------------------------------------------------------- |
| `$ARGUMENTS` | Everything after the command name, as typed.                      |
| `$1` .. `$9` | The nth argument. Quote an argument to keep spaces: `"two words"` |

A template with no placeholder gets the arguments appended as `ARGUMENTS: <text>`, so a
command written for Claude Code or Codex behaves the same here. Substitution is a single
pass: an argument containing `$1` is inserted as text.

A slash that is not the first character is ordinary text, and so is a name that matches no
file. Both reach the model unchanged.

## Trust and limits

The directory is the signed-in user's own, on the hub's machine, and is read the way
skills are: a chat bound to another environment still expands from the hub's directory.
Only a valid file that MangoStudio's target actually reads is expanded. The read refuses a
symlinked or non-regular file and stops at 64 KiB; any failure leaves the typed message
as it was.

The location is always scanned: the Locations setting cannot switch it off, like the skills
and agents directories.

## Built-in commands

Two commands are the composer's own. They act on the chat and are never sent to the model:

| Command         | Does                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/clear`        | Starts a new chat, the same as the sidebar's New chat button.                                                                          |
| `/model <name>` | Switches the chat's model, like the model selector. `<name>` is a model id or display name, or a fragment that fits exactly one model. |

They are listed first in the palette, only for a MangoStudio chat (an external runner's
vendor owns its own `/` namespace), and only when they can run: `/model` needs a chat whose
model selector is enabled, and honours the provider lock after the first turn. A name that
matches no model, or more than one, leaves the text in the composer and says why. When a
built-in is not on offer, it is ordinary text.

A file in `~/.mango/commands` never shadows a built-in: `clear.md` and `model.md` are not
listed in the palette and the hub does not expand them, the way the vendors' CLIs behave.

The replay of an expanded command in later turns is described above; a built-in produces no
message, so it has nothing to replay.
