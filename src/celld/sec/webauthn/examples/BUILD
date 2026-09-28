# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("@root//src/celld/examples:defs.bzl", "celld_example", "celld_example_upstream")
load("@toolchains//celld:defs.bzl", "celld")

# The page script, bundled for the browser and wrapped as a module whose
# default export is its text, which the Worker serves as /client.js.
celld.worker(
    name = "client-js",
    main = "client.ts",
    minify = True,
    deps = ["root//src/celld/sec/webauthn:webauthn"],
)

depot.python_binary(
    name = "wrap-js",
    main = "wrap_js.py",
)

depot.genrule(
    name = "client_script.ts",
    out = "client_script.ts",
    cmd = "$(exe :wrap-js) $(location :client-js) $OUT",
)

celld.library(
    name = "client-script",
    import_name = "@celld/sec/webauthn/examples/client",
    exports = {".": ":client_script.ts"},
)

# A browser and its authenticators, for the spec: the Worker never calls it.
celld_example_upstream(
    name = "authenticator",
    main = "authenticator.ts",
    deps = ["root//src/celld/sec/webauthn:webauthn"],
)

# RP_ID, RP_ORIGINS and SESSION_SECRET are only in the spec's `vars`, which
# reach `.dev.vars` and never the deployed project; the secret is a public
# example. A deployment sets its own with `celld secret put`, and the
# Worker answers an opaque 500 while they are unset.
celld_example(
    name = "passkeys",
    bindings = {
        "PASSKEYS": "PasskeyDirectory",
        "RATE_LIMITS": "RateLimitShard",
    },
    main = "passkeys.ts",
    upstream = ":authenticator",
    deps = [
        "root//src/celld/sec/ratelimit:ratelimit",
        "root//src/celld/sec/webauthn:webauthn",
        "root//src/celld/web/router:router",
        ":client-script",
    ],
)
