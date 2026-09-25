<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/exedev examples

Standalone Workers using `@celld/api/exedev`, each routed with `@celld/router`
and validated with `@celld/sieve` schemas (the library's `VmName`, `Word` and
`FleetSpec` among them). Each runs in its own test against a fake exe.dev
([`upstream.ts`](upstream.ts)): `FakeExe` as the lobby, with VM commands run
through a real `/bin/sh` in a scratch directory per VM; see
[the convention](../../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`vms`](vms.ts) | listing, creating and deleting VMs; quoting; the `ExeKeyLimiter` Durable Object; error kinds |
| [`exec`](exec.ts) | commands on a VM: argv, scripts, exit codes, detached jobs with a status file |
| [`fleet`](fleet.ts) | the `ExeFleet` Durable Object: plan, reconcile, adopt a lost create, prune |
| [`provision`](provision.ts) | a Workflow that provisions, waits, bootstraps once and verifies a VM |
| [`gateway`](gateway.ts) | behind the HTTPS proxy: `exeAuth()` (login redirects for browsers, 401 for others), an integration call |

```sh
buck2 test root//src/celld/api/exedev/examples/...
buck2 run root//src/celld/api/exedev/examples:vms-dev   # then curl 127.0.0.1:9876
buck2 run root//src/celld/api/exedev/examples:vms-dev -- --live --var EXE_API_TOKEN=exe1...
```
