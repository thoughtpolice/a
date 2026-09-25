<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/container examples

Standalone Workers using the shared [example harness](../../examples). Each
runs a real container from the pinned busybox image in [`../image`](../image)
under `celld dev`, so its tests are labelled `needs-docker` (see the
library [README](../README.md#real-container-tests)).

| Example | What it shows |
| --- | --- |
| [`web`](web.ts) | A `Container` subclass serving HTTP from busybox httpd: start on first request with a required port, idle sleep through the alarm, crash noticed and restarted, `onStart`/`onStop` hooks |

```console
$ buck2 test root//src/celld/container/examples/...
$ buck2 run root//src/celld/container/examples:web-dev
```
