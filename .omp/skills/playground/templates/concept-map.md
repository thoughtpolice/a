<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from Anthropic playground/templates/concept-map.md, Apache-2.0, ab024cdc. Modified: keyboard alternatives, provenance-aware edges, safe offline state/export. -->
# Concept map

Use for learning, knowledge gaps, domain relationships, or task decomposition.
Read [the core workflow](../SKILL.md). Put the map above/beside a node list,
relationship selector, actions, and prompt export; canvas is a control, not decoration.

## Populate and interact

Read source first. Use the key concepts that earn a place (often 15–20), with stable
IDs, descriptions, source paths, layer/group, position, visibility, and knowledge
`know | fuzzy | unknown` (default fuzzy). Edges hold endpoint IDs, relationship
type, and provenance `source | user`; source edges must be supported by actual
architecture. Never invent connections to fill a target count.

Render edges first and nodes above on canvas; scale backing dimensions for device
pixel ratio while hit-testing in CSS coordinates. Convert pointer coordinates using
the canvas bounding rectangle; capture the pointer during dragging and clamp nodes
inside the scene. Hit-test circle/box bounds. Hover/focus description tooltips are
text, never raw markup. Draw direction and relationship labels, not color alone.

Provide sidebar buttons to cycle knowledge, visibility toggles, typed edge creation
(from/to selects as a keyboard alternative to clicking A then B), editable numeric
positions or nudge buttons as a dragging alternative, clear user edges, and reset.
Reject nonexistent endpoints and unintended duplicate/self edges. Keep knowledge,
visibility, layout, and relationships in one state so every action updates preview
and export. Retain a textual node/relationship list accessible without canvas.

Optional auto-layout: iterate a bounded spring simulation (100–200 iterations):
pairwise repulsion with a minimum-distance floor; attraction on edges; damp
velocities; clamp positions to bounds. Respect reduced motion and run only on an
explicit action. This feature earns its cost only when layout is genuinely useful.

## Presets and export

Offer 3–5 view presets: zoom out to top-level, focus a real layer, dependency
inspection, full view. Reset restores supplied positions, fuzzy knowledge, and source
edges; don't silently erase user work when switching a view preset.

Export a targeted learning request: domain/codebase context, concepts already
known, fuzzy/unknown concepts to explain, and the typed relationships the user
created or explicitly selected for explanation. Source relationships can orient
the preview but are not automatically the user's requested learning scope.
Use concrete source paths where available. Do not request explanations of hidden
known concepts merely to dump all data. Verify drag/nudge, edge creation/deletion,
knowledge cycling, presets/reset, and that these choices—not unrelated source
edges—determine the generated request.
