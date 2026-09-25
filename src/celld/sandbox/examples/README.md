<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sandbox examples

Standalone Workers using the shared [example harness](../../examples). Each
runs a real container (the pinned busybox image of
[`../../container/image`](../../container/image)) under `celld dev`, so
their tests are labelled `needs-docker`; see the library
[README](../README.md#real-container-tests).

| Example | What it shows |
| --- | --- |
| [`runner`](runner.ts) | A code runner endpoint: one sandbox per user, scripts with a deadline, an output cap, no network, uid 1000 and a clean environment |
| [`jobs`](jobs.ts) | Running tests in a sandbox: upload files, start the test command as a background process, poll it or follow its output as server-sent events |
| [`workspace`](workspace.ts) | A file workspace over HTTP: write, read, list, stat, move and delete, with `..` and outside paths refused |
| [`devserver`](devserver.ts) | A dev server behind a preview URL: a background httpd, `waitForPort`, `exposePort` and `proxyToSandbox` with its token |

```console
$ buck2 test root//src/celld/sandbox/examples/...
$ buck2 run root//src/celld/sandbox/examples:runner-dev
```

The library's own [`integration`](../tests/integration) test uses the same
harness for a broader check of the API against a real container.
