<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# rsvelte compiler overlay

`overlay/src/compiler/phases/3_transform/client/scope_analysis.rs` replaces the
file from rsvelte revision `5ed8ea3a3401b9fbbe780d3b18d6f90073291d6b`. The copied
source retains its upstream MIT attribution.

The only semantic change separates the borrow lifetime of `Finder.semantic`
from the source/AST lifetime inside `Semantic`: `&'s Semantic<'data>` instead of
`&'s Semantic<'s>`, with a matching visitor implementation parameter.

The shared Oxc revision is `60fa13878c3808413268c462ddadbceaf71c38bb`. Its linter
enables `oxc_semantic/linter`, which enables `jsdoc`; JSDoc's interior-mutable
cache makes `Semantic` invariant in its data lifetime. Equating that lifetime
with a short visitor borrow fails to compile. Do not omit the linter/JSDoc
features to work around the error.

When updating rsvelte, compare this overlay against the newly pinned file.
Remove it when upstream has separated the lifetimes. Reindeer regenerates the
replacement as `mapped_srcs`; do not modify downloaded sources or generated
`BUILD` by hand. `build.rs` supplies `SVELTE_VERSION`, and `cargo_env` supplies
`CARGO_PKG_VERSION` for the compiler fingerprint.
