<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/exedev examples

Standalone Workers using `@celld/api/exedev`, each routed with `@celld/web/router`
and validated with `@celld/sieve` schemas (the library's `VmName`, `Word` and
`FleetSpec` among them). Each runs in its own test against a fake exe.dev
([`upstream.ts`](upstream.ts)): `FakeExe` as the lobby, with VM commands run
through a real `/bin/sh` in a scratch directory per VM; see
[the convention](../../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`vms`](vms.ts) | listing, creating and deleting VMs; quoting; a shared `@celld/sec/ratelimit` limiter; error kinds |
| [`exec`](exec.ts) | commands on a VM: argv, scripts, exit codes, detached jobs with a status file, each job id claimed once on the VM (409 when reused) |
| [`fleet`](fleet.ts) | the `ExeFleet` Durable Object: plan, reconcile, adopt a lost create, prune |
| [`provision`](provision.ts) | a Workflow that provisions, waits, bootstraps once and verifies a VM |
| [`gateway`](gateway.ts) | behind the HTTPS proxy: `exeAuth({ trust })` (login redirects for browsers, 401 for others), an integration call with redirects refused and a 5 second deadline |

`vms`, `exec`, `fleet` and `provision` drive real VMs, so every route
needs the operator token (`Authorization: Bearer op_...`, at least 128
random bits). The Worker holds only its SHA-256, in the secret
`OPERATOR_TOKEN_SHA256`, which each spec sets in its `vars`; unset, every
request is a 401. Never deploy these routes without it. `gateway` uses
`exeAuth` and trusts the proxy's headers only from `EXE_PROXY_PEERS`; its
test sets `EXE_ANY_PEER_FOR_DEVELOPMENT`, which trusts every peer and must
never be set on a deployed Worker.

```sh
buck2 test root//src/celld/api/exedev/examples/...
buck2 run root//src/celld/api/exedev/examples:vms-dev   # then curl 127.0.0.1:9876 with the token from vms.json's steps
buck2 run root//src/celld/api/exedev/examples:vms-dev -- --live --var EXE_API_TOKEN=exe1...
```
