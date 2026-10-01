---
name: frontend-design
description: Design and implement distinctive frontend interfaces, pages, and components grounded in their audience and subject. Use for new UI or visual redesign, including responsive accessibility and actual browser critique; not for backend-only work.
---
<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from Anthropic claude-plugins-official frontend-design/skills/frontend-design/SKILL.md, Apache-2.0, ab024cdc. Modified for native tools and browser verification; approval ceremony removed. -->

# Frontend design

## Ground the design

Read the existing UI and the request with `find` and `read`. Identify the subject,
audience, primary user job, real content, existing design system, and constraints.
Use repository-provided answers; ask only a material decision that changes the result.
Do not block implementation on a ritual design-plan approval.

Choose a compact direction before coding: 4–6 named color tokens with hex values,
type roles and scale, spacing, one layout concept, alignment, and the feature that
makes this particular subject recognizable. Honor explicit user choices. Critique
whether the same plan could fit an unrelated product; revise generic choices and
state briefly why. Spend boldness in one memorable place; keep its surroundings quiet.

## Implement intentionally

- Lead with the subject's characteristic content: a useful interactive preview,
  image, headline, or data treatment, not a stock hero/stat/gradient kit.
- Use one or two deliberate type families. System fonts are appropriate for offline
  artifacts; use existing bundled assets for branded UIs, not an unsolicited CDN.
  Keep most body lines under 80 characters; give serif text sufficient line-height.
- Structure conveys meaning. Number only sequences; borders separate real groups;
  labels identify content rather than decorate it. Avoid repeated identical cards,
  arbitrary eyebrow labels, gratuitous all-caps, a single accented headline word,
  or a habitual palette unless the brief calls for them.
- Reuse the codebase's components/tokens and selector conventions. Keep specificity
  predictable; do not let overlapping element/classes silently cancel spacing.
- Animate response to a user's action. Use unsolicited motion sparingly and honor
  `prefers-reduced-motion`. Never make animation the only explanation of state.
- Use semantic landmarks, headings, labels, native controls, visible focus,
  keyboard interaction, contrast, and explicit loading/error/empty states. Convey
  status in words as well as color. Keep wide tables/code in local scroll containers.
- Write from the user's perspective: “Save changes,” not “Submit”; same action name
  in button and confirmation. Errors say what happened and how to recover. Empty
  states offer a concrete action. Plain verbs and sentence case beat sales filler.

## Verify the actual surface

Run the repository's supported development/preview command, then use `browser`
through `eval` (read `xd://eval/browser` first). Open the real page, perform the
primary action and a meaningful error/empty path, and inspect screenshots at a
phone viewport and a desktop viewport. Check keyboard focus, long real content,
overflow, contrast, disabled/loading states, and reduced motion where relevant.
For an offline artifact, open the generated file through a local preview server;
verify it makes no external requests. Close the tab when finished.

Critique the screenshot against the direction and user job; remove decoration
that earns no place. Fix clipping, confusing copy, broken interactions, or weak
hierarchy, then inspect the changed surface again. Report what was observed, the
output path/preview address, and any visual limit honestly. Source inspection or a
passing unit test is not evidence that a page looks or works correctly.
