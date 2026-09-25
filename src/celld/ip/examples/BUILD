# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//src/celld/examples:defs.bzl", "celld_example")

celld_example(
    name = "firewall",
    main = "firewall.ts",
    vars = {
        "ADMIN_ALLOW": "192.0.2.0/28, 2001:db8:a::/48",
        "DENY": "203.0.113.0/24, 2001:db8:bad::/48",
        "TRUSTED_PROXIES": "10.0.0.0/8, fd00::/8",
    },
    deps = ["root//src/celld/ip:ip"],
)

# The same Worker with a mistyped DENY block, which must fail closed.
celld_example(
    name = "firewall-typo",
    main = "firewall.ts",
    spec = "firewall_typo.json",
    vars = {
        "ADMIN_ALLOW": "",
        "DENY": "",
        "TRUSTED_PROXIES": "",
    },
    deps = ["root//src/celld/ip:ip"],
)

celld_example(
    name = "subnet",
    main = "subnet.ts",
    deps = ["root//src/celld/ip:ip"],
)

celld_example(
    name = "ratelimit",
    bindings = {"BUCKETS": "Bucket"},
    main = "ratelimit.ts",
    vars = {
        "BURST": "3",
        "IPV4_PREFIX": "24",
        "IPV6_PREFIX": "64",
        "PER_MINUTE": "1",
    },
    deps = ["root//src/celld/ip:ip"],
)
