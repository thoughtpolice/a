<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/core/assert examples

`@celld/core/assert` is a test library, but its assertions are plain functions,
so a Worker can use them too. Each example runs in its own test under
`celld dev`; see [the convention](../../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`selfcheck`](selfcheck.ts) | a `/healthz` that runs `assert`, `assertEquals`, `assertCode` and `assertOk` against the deployed Worker; `selfcheck-misconfigured` is the same Worker with a bad `TAX_RATE` |
| [`drift`](drift.ts) | configuration drift with `equals` (structural, bytes included) and `show`; an unauthenticated local demo, where anyone can overwrite the desired state |

A failing `/healthz` only tells a load balancer to stop routing to the
deployment; it does not stop the Worker's other routes. So `selfcheck`
validates `TAX_RATE` again in `/quote`, which answers 503 instead of charging
at a bad rate.

```sh
buck2 test root//src/celld/core/examples/assert/...
buck2 run root//src/celld/core/examples/assert:selfcheck-dev   # then curl 127.0.0.1:9876
```
