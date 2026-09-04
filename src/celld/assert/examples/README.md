<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/assert examples

`@celld/assert` is a test library, but its assertions are plain functions,
so a Worker can use them too. Each example runs in its own test under
`celld dev`; see [the convention](../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`selfcheck`](selfcheck.ts) | a `/healthz` that runs `assert`, `assertEquals`, `assertCode` and `assertOk` against the deployed Worker; `selfcheck-misconfigured` is the same Worker with a bad `TAX_RATE` |
| [`drift`](drift.ts) | configuration drift with `equals` (structural, bytes included) and `show` |

```sh
buck2 test root//src/celld/assert/examples/...
buck2 run root//src/celld/assert/examples:selfcheck-dev   # then curl 127.0.0.1:9876
```
