<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from Anthropic playground/templates/design-playground.md, Apache-2.0, ab024cdc. Modified: accessible offline workflow, bounded style inputs, complete state/preset/export semantics. -->
# Design playground

Use for visual decisions: buttons, cards, layout, density, palette, type scale,
responsive breakpoints, or dialogs. Read [the core workflow](../SKILL.md) first.

## Build

Place grouped controls beside a preview of the actual component in context, with
prompt export below. Stack on phones. Separate immutable `defaults`/`presets` from
mutable `state`. Store numeric spacing/radius/size, color tokens, layout enum,
viewport width, and interaction flags; bound numeric values and use allowlisted
font/easing/layout choices instead of injecting arbitrary CSS.

| Decision | Control | Preview consequence |
|---|---|---|
| Padding, gap, radius, shadow | Labeled range + numeric output | Assign bounded inline style values |
| Font, scale, weight, line height | Select/range | Render headings, body, caption together |
| Accent/surface/contrast | Color controls | Show actual text and focus against the surface |
| Layout | Radio-card group | Change sidebar/grid/navigation structure |
| Responsive behavior | Viewport-width range | Resize local preview container; show reflow |
| Border, hover, context | Checkbox/select | Show light/dark context and meaningful states |

Every input calls `updateAll()`; it synchronizes control labels, assigns styles to
existing preview elements, and exports the request. Include hover, focus, disabled,
and long-content states where the component needs them. The viewport slider must
not resize the application's controls. Do not require page reload to see changes.
Use container queries or bounded preview widths when the explored breakpoint is
independent of the browser width.

Presets should express intentions (e.g. compact utility, comfortable reading,
expressive display), each specifying the full configurable state. Reset restores
defaults; selecting a preset updates every control and output coherently.

## Export and proof

Frame the export as a developer direction: “Update the account card to feel compact:
16px padding, 6px radius, and a subtle 0 2px 8px shadow; at 480px stack its actions.”
Include the component/context and only non-default values. Match raw CSS or the
project's existing utility classes; do not invent an unsupported framework.
When no changes exist, say the current defaults are selected rather than issuing
an incomplete “use …” request. Verify sliders, switches, preset/reset, keyboard,
phone stacking, long text, and prompt contents after two interacting changes.
