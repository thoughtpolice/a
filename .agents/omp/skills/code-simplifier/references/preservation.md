<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official code-simplifier/agents/code-simplifier.md and pr-review-toolkit/agents/code-simplifier.md at ab024cdc (Apache-2.0); expanded preservation checks for OMP. -->

# Preserve more than return values

Before removing a branch or merging helpers, check the contract on both sides:

- **Values and errors:** null/undefined versus empty, parsing/coercion, overflow, stable ordering, exception types/causes, and precedence between multiple invalid inputs.
- **Evaluation order:** moving a guard can skip required validation or side effects; combining expressions can change short-circuit behavior. Never compute expensive or allocating values merely to make branches shorter.
- **State and resources:** ownership transfer, mutation/aliasing, atomic publication, cleanup on early return/throw, and disposal exactly once.
- **Async behavior:** awaiting versus returning a promise affects catches and cleanup; moving an await can change concurrency, cancellation or race behavior.
- **Performance:** preserve algorithmic complexity and avoid unnecessary allocation, copying, repeated computation, and lost fast paths. A shorter chain of transformations may allocate more than an explicit loop.
- **Public contracts:** preserve exports, supported inputs, and caller assumptions; migrate callers if an internal API is simplified, without obsolete aliases.

Good candidates: duplicated pure conditions, unnecessary nesting, obsolete code proven unreachable after a cutover, misleading names, comments narrating obvious statements, and abstractions used only to obscure a straightforward operation.

Bad candidates: compact ternary ladders, merging unrelated concerns, replacing a useful domain abstraction with repeated conditionals, broadening catches, hiding errors with defaults, or deleting a fallback solely because it looks complex. Complexity that represents a real requirement must remain explicit.

Verification should cover at least the normal path and the preservation hazard introduced by the edit (for example failure cleanup or evaluation order). Existing consumer-behavior tests can supply regression coverage; a targeted smoke must still exercise the changed surface. Record untested boundaries rather than claiming exact equivalence from code appearance.
