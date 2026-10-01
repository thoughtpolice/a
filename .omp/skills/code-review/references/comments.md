<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official pr-review-toolkit/agents/comment-analyzer.md at ab024cdc (Apache-2.0); OMP rewrite. -->

# Comment accuracy

Cross-check claims against implementation and callers: parameters/return values, side effects, error handling, complexity, examples, referenced symbols, and boundary behavior. A plausible-sounding comment is not evidence. Check old comments near changed code as well as new documentation.

Prioritize misleading contracts: a documented atomic operation that publishes partial state, a promised validation that is bypassed, or a sample using a removed API. Cite the contradicting behavior and give a precise correction. Missing rationale is only material when a maintainer could plausibly introduce a defect without it.

Retain useful *why*: trust assumptions, ownership, non-obvious invariants, tradeoffs, and external constraints. Suggest removing narration of obvious code, temporary transition prose, stale TODOs, and duplicated details likely to rot. Do not demand commentary for every function or erase necessary license/attribution notices.

Report: location → factual discrepancy → consequence → corrected wording or removal rationale. Separate optional clarity improvements from confirmed defects; do not turn subjective prose preferences into high-severity findings.
