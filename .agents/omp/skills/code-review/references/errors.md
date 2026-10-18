<!-- SPDX-FileCopyrightText: © 2024-2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Modified from Anthropic claude-plugins-official pr-review-toolkit/agents/silent-failure-hunter.md at ab024cdc (Apache-2.0); removed project-specific telemetry and blanket severity policies. -->

# Errors and fallback behavior

Enumerate changed catch/Result branches, error callbacks, defaults, retries, cleanup, and log-and-continue paths. Inspect optional chaining/null-coalescing when absence could mean failure; these operators are not defects on their own.

For each branch:

- Which expected errors does it handle, and which unexpected failures could it swallow? Does it turn authentication, corruption, or programming errors into an apparently successful empty/default result?
- Who owns reporting? Preserve useful operation/context and cause at the appropriate layer without logging secrets or requiring redundant logs at every layer. Verify user-visible errors are actionable and do not reveal sensitive internals.
- Is fallback part of the actual contract? Is the alternative equivalent or explicitly degraded? Does the caller learn the operation failed? Production stubs, fabricated success, and unexplained fake data are not legitimate recovery.
- Do propagation, cancellation and cleanup preserve state/ownership? Check disposal on both success and failure, partial writes, rethrows losing cause, and retries exhausted without a terminal error.
- Does a broad handler exist for a valid boundary reason (for example cleanup followed by rethrow), or does it suppress unrelated failures?

Prove the hidden failure and its caller-visible impact before assigning severity. Expected absence or a documented best-effort operation can legitimately return a default; an empty catch is a lead, not automatically a critical defect. Recommend the smallest correct propagation/recovery change using existing repository error conventions—no invented telemetry service, retry layer, or error-ID system.

Report location, triggering error, suppressed information/state change, user impact, and concrete correction. Add a failure-path test only if it catches the real contract break.
