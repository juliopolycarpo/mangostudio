---
name: "Reviewer"
description: "Reviews diffs."
role: both
model: "gpt-test"
tools:
  - "read_file"
  - "list_directory"
subagents:
  - "user:researcher"
alpha: true
zeta: "last"
---

Review carefully.
