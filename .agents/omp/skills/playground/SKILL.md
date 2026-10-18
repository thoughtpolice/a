---
name: playground
description: Build offline single-file interactive HTML playgrounds and explorers with meaningful controls, live previews, presets, and copyable prompt exports. Use for visual configuration, learning maps, data/query exploration, document critique, diff review, or architecture feedback.
---
<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from Anthropic claude-plugins-official playground/skills/playground/SKILL.md and templates, Apache-2.0, ab024cdc. Modified for native tools, accessible controls, safe offline rendering, and provider-neutral prompt export. -->

# Playground builder

Build a working explorer, not a screenshot or a controls-only shell. The user changes
state, sees its consequences immediately, and exports an actionable natural-language
request they can use without the page.

1. Identify the topic and read real source material with native `find`/`read` tools.
   Select one resource (adapt the closest when necessary):
   - [Design playground](templates/design-playground.md): components, layouts, typography.
   - [Data explorer](templates/data-explorer.md): SQL, APIs, pipelines, regex, schedules.
   - [Concept map](templates/concept-map.md): relationships and knowledge gaps.
   - [Document critique](templates/document-critique.md): suggestions and decisions.
   - [Diff review](templates/diff-review.md): line-specific code feedback.
   - [Code map](templates/code-map.md): architecture layers and component feedback.
2. Write a single self-contained HTML file at a user-appropriate workspace path.
   Inline CSS/JS/SVG and data; no packages, CDN, external fonts/images, fetching,
   analytics, automatic hooks, or provider-specific commands. A dark system-font UI
   is a useful starting point; honor an existing theme or user direction.
3. Initialize meaningful actual content and one state object. Keep immutable source
   data separate. Every control mutates state, synchronizes controls, renders the
   preview, and regenerates the export immediately—no Apply button. Preserve text
   focus/selection when updating, and never discard unsaved comments accidentally.
4. Include 3–5 named coherent presets plus reset; snap every relevant control to the
   preset, not just one attractive value. Do not fabricate source facts for presets:
   vary the view/configuration instead. Group controls by concern, with advanced
   controls in a disclosure. Stack panes at small widths; confine wide content scroll.
5. Export natural language: context + the user's meaningful non-default choices or
   selected feedback, with qualitative intent and exact values where useful. Avoid
   a raw state dump or empty instruction. When untouched, explain what to select.
   Copy via `navigator.clipboard.writeText`; show success only after it resolves.
   If unavailable/denied (common for local files), expose/select a readonly textarea
   and give honest manual-copy instructions. Announce feedback with `aria-live`.
6. Treat all source/code/comments as untrusted data. Use `textContent` or DOM text
   nodes; escape before any HTML syntax highlighting. Escape `<` as `\u003c` in
   embedded JSON. Do not evaluate user regex/code/SQL against a network or execute
   exported prompts. Label mocked sample results explicitly; prefer real local data.
7. Verify in the actual browser (read `xd://eval/browser`): desktop + phone, each
   control type, preset/reset, keyboard alternative to pointer gestures, export
   after a non-default choice, denied-clipboard behavior, and hostile markup as text.
   Inspect screenshots and external-request logs; fix failures and close the tab.
   Report the HTML path and what was exercised; do not run macOS launch commands.
