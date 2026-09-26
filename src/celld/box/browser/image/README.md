<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Browser image

This is a native Chromium **headless shell**, not the Chrome desktop, the
`content_shell` developer test binary, a Browserless service, or a bundled
Playwright installation. Debian calls it `chromium-headless-shell`; it implements
Chromium's standalone/old headless mode. DOM, JavaScript, CDP navigation, and PNG
screenshots work in the verified configuration. Chrome UI, extensions, PWA
integration, GPU/WebGL, and full-Chrome behavioral equivalence are not promised.

The base image is a pinned multiarchitecture Debian index. The Chromium pin
was refreshed to `154.0.8037.92-1~deb13u1` on 2026-10-02 after Debian's rolling
security repository replaced `.57`; the [package listing](https://packages.debian.org/trixie/chromium-headless-shell)
publishes `.92` for both arm64 and amd64. Other direct packages remain pinned.
Transitive packages still come from Debian's signed rolling repositories: this
Dockerfile is **not** a complete reproducible dependency lock. Archive and review
the resulting image digest and SBOM for deployment, refresh the browser pins for
security updates, and rerun acceptance tests after any update. The measurements
below are historical `.57` evidence, not runtime proof for the refreshed pin.

## Lifecycle and isolation

The default command only keeps the container alive. After its hostile-tier
gVisor check, `BrowserSandbox` creates `/workspace/site`, writes its fixture, and
starts the root-owned, non-writable `/usr/local/bin/celld-browser` launcher as
uid/gid `1000:1000`. The launcher accepts no arguments and invokes the browser
binary directly, bypassing environment-controlled distribution wrappers.

The launcher starts:

- A local static fixture server on `127.0.0.1:8080`, rooted at `/workspace/site`.
- Chromium CDP on `127.0.0.1:9223` with namespace/seccomp sandboxing enabled.
- A private TCP relay on container port `9222`, limited to 16 child connections.

CDP grants complete browser control. Never publish the relay, a raw browser
websocket, or an unrestricted forwarding route. The owning Worker is responsible
for access control and lifecycle cleanup; the fixture disposes its container.
The relay can listen before CDP is ready, so readiness requires a successful
bounded `/json/version` check, not merely an open port. Browser profile state is
ephemeral under `/workspace/browser-profile`.

There is no `--no-sandbox`, sandbox-disabling flag, privileged runtime, added
capability, or unconfined seccomp profile. GPU and software-3D backends are disabled
for this CPU-only fixture. Runtime identity still comes from the hostile-tier
probe before launch, not the image tag or an environment variable.

## Verified footprint and behavior

The 2026-09-26 native arm64 diagnostic ran with `--runtime=runsc`,
`--user=1000:1000`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
`--pids-limit=256`, and `--memory=1g`. It created a real target through CDP,
navigated an HTML document, evaluated its title and DOM text, and captured a PNG.
`Browser.getVersion` reported `HeadlessChrome/154.0.8037.57`. This is local browser
acceptance, not verification of production ingress, TLS, or cross-site cookies.

Measured Docker image sizes (uncompressed, same host and date):

| Candidate | Bytes | Result |
| --- | ---: | --- |
| Debian headless shell, selected | 643,970,308 | DOM, JavaScript, screenshot passed |
| Debian content shell | 650,240,787 | DOM passed; nonstandard empty product branding |
| Alpine full Chromium | 746,771,571 | GPU subprocess sandbox failure; rejected |
| Debian full Chromium | 816,644,102 | DOM passed; larger desktop dependency set |

This is the smallest validated candidate, not a claim that no smaller image is
possible. It retains distribution-declared dependencies rather than deleting
shared libraries or browser resources based on one successful smoke test.

Build and exercise the current image through the Buck-managed runner:

```sh
buck2 test root//src/celld/box/browser:smoke-test
```

The runner chooses the host architecture, builds the packaged image with celld's
dry-run deployment, then exercises the browser under runsc. A Docker engine with
runsc registered is required; there is no insecure fallback.
