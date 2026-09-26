<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/box/browser — browser tests under celld/runsc

A small POC: ordinary TypeScript `Deno.test` functions control a disposable
Chromium headless shell through the Chrome DevTools Protocol (CDP). Buck starts
celld, celld starts a hostile-tier sandbox on **runsc**, and the fixture destroys
the browser on success, failure, or cancellation. No npm browser driver is needed.

```sh
buck/bin/buck2 test root//src/celld/box/browser:smoke-test
# Unit tests, type checks and lint, without Docker:
buck/bin/buck2 test root//src/celld/box/browser: --exclude needs-docker
```

Requires Linux, a Docker engine with the `runsc` runtime installed, and network
access to build the image on the first run. Missing runsc is a failure, never an
automatic fallback or skip. The warm smoke test starts two fresh containers;
image downloads have a separate ten-minute deadline. Native ARM64 is the tested
development platform; AMD64 package availability is checked, not runtime-proven.

## Add a test

In your package's `BUILD`:

```python
load("@root//src/celld/box/browser:defs.bzl", "browser_test")

browser_test(
    name = "ui-test",
    main = "ui_test.ts",
    deps = [
        "root//src/celld/box/browser:browser",
        "root//src/celld/core:core",
    ],
)
```

The macro bundles and checks the driver, owns a private `celld dev` instance,
and grants the Deno driver only loopback networking and two environment values:

```ts
import { assert } from "@celld/core/assert";
import { withBrowserFixture } from "@celld/box/browser";

Deno.test("browser works", async () => {
  await withBrowserFixture({
    endpoint: Deno.env.get("CELLD_BROWSER_ENDPOINT")!,
    token: Deno.env.get("CELLD_BROWSER_TOKEN")!,
    html: "<!doctype html><title>My component</title>",
  }, async ({ cdp, origin }) => {
    const version = await cdp.send<{ product: string }>("Browser.getVersion");
    assert(version.product.includes("Chrome"), "expected Chromium");
    await cdp.send("Target.createTarget", { url: origin });
  });
});
```

The complete [smoke test](tests/integration/browser_test.ts) demonstrates flattened
target sessions, navigation, waiting for the document, real DOM/JavaScript
assertions and teardown after an intentional test failure. `send<T>` is a caller
type assertion, not runtime validation of a particular CDP method's result.
Use the [official protocol reference](https://chromedevtools.github.io/devtools-protocol/)
for command parameters. No selectors, implicit waits or Playwright-style DSL are
invented here. Unsolicited CDP events are currently discarded.

## Boundaries and defaults

- Each callback owns one new browser/profile and a static `index.html`, at most
  64 KiB. The page is served **inside** the container on `http://127.0.0.1:8080`;
  that origin is not a host-side URL. Internet access is disabled.
- Setup plus callback defaults to 60 seconds (maximum five minutes). Individual
  CDP commands have a 30-second limit in the fixture; cleanup has an independent
  60-second budget, even if startup's response was lost. No automatic retries or
  command replay occur. Aborting a command stops waiting, not browser execution.
- The transport defaults to 64 in-flight commands and 1 MiB messages. Native
  WebSocket frame buffering happens before this bound; this is not a hostile
  websocket server parser. Test code and its chosen CDP commands are trusted.
  The Worker bridge additionally caps a session at 4096 frames, 16 MiB of total
  forwarded text and five minutes; oversized/binary messages close both ends.
  Each fixture capability permits exactly one websocket upgrade attempt.
- Control requests use a fresh per-run random bearer secret. Websocket URLs are
  short-lived capabilities with a separate random 256-bit session identifier.
  Never log or publish them. The runner redacts them from diagnostics.
- The Worker binds only to `127.0.0.1`. It rejects browser `Origin` headers,
  implements no CORS, and forwards only the exact stored browser-debugging path.
  Do not deploy this control Worker as a public browser service. The `/durable`
  export is infrastructure code, not a user-authorized RPC surface.
- The fixture performs the sandbox's real hostile-tier gVisor check before
  launching the immutable image helper. Chromium's own namespace/seccomp sandbox
  remains enabled. No privileged containers or `--no-sandbox` switches.
- The host runner stops celld even if the driver fails, times out, or receives
  SIGINT/SIGTERM. SIGKILL/host failure cannot run user-space cleanup; production
  use would need external reaping and resource quotas.

## Image choice and POC limits

celld's direct outbound-WebSocket response path collides with its ingress
socket registration (see the toolchain's
[AGENTS.md](../../../../buck/toolchains/celld/AGENTS.md)). This package uses a distinct accepted `WebSocketPair` and
an explicit bounded relay inside the Durable Object. Do not replace it with
`return await containerFetch(...)` until that runtime behavior is fixed and the
real browser test passes. The real smoke test is the regression for this path.

The selected dedicated Debian `chromium-headless-shell` image is about **614 MiB
uncompressed** on ARM64: the smallest candidate we actually validated under
runsc. It excludes Node, a browser service, and the full Chrome desktop. See
[image measurements and pins](image/README.md). Browserless is useful when a
browser service is needed, but its [image](https://github.com/browserless/browserless/blob/main/docker/chromium/Dockerfile)
and [base](https://github.com/browserless/browserless/blob/main/docker/base/Dockerfile)
include service/runtime tooling this fixture does not use. We did not measure a
Browserless pull or claim an exhaustive global image-size search.

This is standalone/old headless Chromium, not full-Chrome behavioral equivalence.
GPU/WebGL, extensions and PWA integration are out of scope. The fixture proves
browser control and DOM behavior, **not** deployed TLS, cross-site OAuth/cookie
policy, proxy trust, preview-origin separation or HSTS. Those audit gates remain
open. Next extensions are multiple fixture assets/origins, a reviewed route to
the application under test, event subscriptions and bounded artifact collection.
Do not enable arbitrary Internet access to simulate that future application path.
