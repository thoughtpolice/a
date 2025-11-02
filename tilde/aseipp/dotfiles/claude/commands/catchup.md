---
description: Catchup on the current stack(s) of work you're doing
model: claude-sonnet-4-5
---

Catch up on the current work being done by looking at the current commit stack and seeing what is being worked on. (Often, when you are asked to do this, it will be when the context is fully fresh.)

Run the following command to get the current stack of commits in JSONL format, with full description included:

`jj log --ignore-working-copy --no-graph -r 'stack()' -T 'json(self) ++ "\n"'`

Given the change ID or commit ID of any of these commits, you may use the command `jj log --stat -r $ID` in order to see the diffstat.

Use `jj log -r $ID --patch` in order to see the full patch for true insight.

Use this information to get up to speed quickly on what is being actively worked on so that you can take further action.
