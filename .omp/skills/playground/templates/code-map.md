<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from Anthropic playground/templates/code-map.md, Apache-2.0, ab024cdc. Modified: evidence-based architecture, keyboard/dialog behavior, safe offline rendering and export. -->
# Code map

Use for module architecture, components, microservices, pipelines, or plugin systems.
Read [the core workflow](../SKILL.md). Put filters, view presets, legend, and comments
beside an inline SVG scene; place export under the diagram.

## Acquire and render

Read real imports/calls/source definitions. Select key components (often 15–25)
with stable ID, label, exact file path, layer, position, and dimensions. Edges have
endpoint IDs, type, label, and source/basis. Use only evidenced relationships;
label an inference and its basis instead of inventing a diagram to reach 20–40
edges. Arrange nodes in bands by logical layer (UI/API/core/data/external).

Render edges beneath nodes, use arrow markers and labeled bezier paths, and keep
an accessible textual relationship list. Distinguish 3–5 real connection types by
labels and dash patterns as well as color: data flow solid, calls long-dashed,
events short-dashed, dependencies dotted. Build SVG nodes with `createElementNS`
and text nodes, never interpolated untrusted markup. Node label/path must remain
readable when zooming and in both light/dark modes.

State holds layer visibility, edge-type visibility, zoom/pan, active component,
comment draft, and saved comments keyed by component ID. Filtering edges requires
both endpoints visible as well as the selected edge type. Provide +/−/reset zoom,
checkbox filters, and 3–5 full-state view presets (full system, client, backend,
data flow, a grounded feature). Presets modify view, never saved comments.

Click or keyboard-activate a node to open a labeled comment dialog with component
name/path. Focus the textarea; Escape/cancel discards the draft; Save records it;
return focus to the invoking node. A sidebar list shows comment context and delete
buttons; deletion clears the indicator and export. Include keyboard-accessible
component list controls for users who cannot operate SVG. Keep unsaved drafts
intact when unrelated view state changes.

## Export and proof

Export project context, non-default visible layers/edge focus, and only the user's
saved component comments, each with name and path. Do not manufacture feedback
from source descriptions. If no comments exist, an explicit chosen inspection
scope can form an exploration request; otherwise guide the user to select/comment.

Verify layer filtering removes incident edges, edge-type filtering, presets,
zoom/reset, keyboard dialog/save/cancel/focus return, comment deletion, hostile
labels/paths/comments, phone layout, and exported context after a focused view.
