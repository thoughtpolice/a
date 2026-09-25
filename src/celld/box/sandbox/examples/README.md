<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/box/sandbox examples

Standalone Workers using the shared [example harness](../../../examples). Each
runs a real container (the pinned busybox image of
[`../../container/image`](../../container/image)) under `celld dev`, so
their tests are labelled `needs-docker`; see the library
[README](../README.md#real-container-tests).

| Example | What it shows |
| --- | --- |
| [`runner`](runner.ts) | A code runner for untrusted code: expiring bearer-token callers (`auth.ts`), one sandbox per caller named by a domain-separated keyed hash of the caller's canonical identity tuple, each run in its own directory within one exec, 2 runs at once per caller, opaque errors; the production class is `hostile` and needs runsc |
| [`runner-hostile`](runner.ts) | The same Worker without the development opt-in: the `hostile` class refuses to run on runc, with an opaque 503 |
| [`jobs`](jobs.ts) | Running tests in a sandbox: authenticated callers upload files and a test command into a new directory per job, poll it or follow its output as server-sent events; bodies capped at 8 MiB (413) and parsed under the job's own caps; job ids mean nothing outside their owner's sandbox; a job's directory lasts until it is deleted or the container stops |
| [`workspace`](workspace.ts) | A file workspace over HTTP: write (with the body read under its cap by `readBounded`), read, list with paging, stat, move and delete, with `..` and outside paths refused; one shared demo workspace, **no authentication** |
| [`devserver`](devserver.ts) | A dev server behind a preview URL: a background httpd, `waitForPort`, `exposePort` and `proxyToSandbox` with its token; the object starts httpd once for overlapping starts (`devserver_race-test`, no container); **no authentication** |

**Identity.** `runner` and `jobs` take `authorization: Bearer
<subject>.<unix-expiry>.<mac>`, where `mac` is the base64url HMAC-SHA256 of
`"subject-exp:" + subject + ":" + unixExpiry` under `AUTH_SECRET` (see
[`auth.ts`](auth.ts)). Expiry is required, must be in the future, and may be at
most one hour away. A deployment sets its own secret of at least 32 characters
and mints tokens where users log in. The checked-in specs set a development
secret in their `vars` and explicitly enable `UNSAFE_DEMO_AUTH=1` so their
reproducible legacy `<subject>.<mac>` fixtures work; never enable that escape
hatch in a deployment. Nothing a caller sends names a sandbox: the id is `t-`
plus a domain-separated keyed hash of the canonical fixed-scheme identity tuple,
including the verified subject.

**Unauthenticated demos.** `workspace` and `devserver` check no caller.
Anyone who can reach `workspace` can read, overwrite, list and delete
every file in its one shared sandbox and keep its container running;
anyone who can reach `devserver` can start and stop the server and get its
preview token, and with it the preview URL. They answer errors with the
sandbox's code only. Never deploy either.

**Runtime.** Every example here runs on the engine's default runtime
(runc), which shares the host kernel and is not a boundary against
hostile code. In `jobs` any token holder runs any command, each in their
own sandbox, so isolation between callers holds only while no caller
attacks the runtime; mutually untrusted callers need the `hostile` tier
with runsc, as in `runner`. `runner`'s production class `Runner` is on the
`hostile` tier, which refuses to run anything unless the container runs on
gVisor (declare it with `"runtime": "runsc"`). The development fixture
deliberately exercises runc: it binds `UnsafeTrustedRunner` as well, and
`runner.json` opts into it with `UNSAFE_RUNNER_ON_RUNC=1` in its `vars`;
its answers say `"tier": "trusted (unsafe)"`. `runner-hostile` runs the
same project without that variable and shows the refusal. Drop both the
class and the variable in a deployment. Neither development fixture
replaces the required positive
`root//src/celld/box/sandbox:integration-runsc-test` acceptance lane on the
intended image/runtime.

```console
$ buck2 test root//src/celld/box/sandbox/examples/...
$ buck2 run root//src/celld/box/sandbox/examples:runner-dev
```

The library's own [`integration`](../tests/integration) test uses the same
harness for a broader check of the API against a real container.
