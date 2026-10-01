<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official pr-review-toolkit/agents/type-design-analyzer.md at ab024cdc (Apache-2.0); OMP rewrite. -->

# Type design and invariants

List the type's real business invariants: field relationships, ownership/lifetime, allowed values, legal transitions, preconditions and postconditions. Trace every construction, deserialization, mutation, copy, and exposed reference that can affect them.

Evaluate four distinct axes:

1. **Encapsulation:** can external callers mutate internal state or bypass the intended interface?
2. **Expression:** does the structure make legal/illegal states clear (for example a discriminated state rather than contradictory flags)? Can the compiler enforce a useful constraint?
3. **Usefulness:** does that constraint prevent a plausible bug for actual consumers, or needlessly exclude valid usage?
4. **Enforcement:** do construction and all mutation paths preserve the invariant, including runtime inputs that static types cannot validate?

For a requested type-design assessment, rate each axis 1–10 with evidence and limitations, not a synthetic aggregate. For a defect review, report a concrete reachable invalid state rather than a score. Check mutable aliases, assertions/casts that bypass validation, documentation-only guarantees, inconsistent constructors, and unchecked external data.

Prefer simple immutable values or narrow interfaces where they fit existing conventions. Do not require domain classes for plain data, clever generic encodings, duplicate runtime validation, or unnecessary allocations. A safer type change must justify its migration/performance cost and migrate all callers rather than introducing compatibility shims.
