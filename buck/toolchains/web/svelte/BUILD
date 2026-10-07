# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(":defs.bzl", "svelte_runtime")

# Only runtime sources and official projection types are consumed. No package
# manager, install hooks, or JavaScript compiler runs in this build graph.
ARCHIVES = {
    "svelte": ("5.57.1", "62a37dd4a142537039f0389ee6f39812ad4554b19492d8f073bef6e52c71c3ce", "https://registry.npmjs.org/svelte/-/svelte-5.57.1.tgz", "package"),
    "svelte2tsx": ("0.7.61", "a0d9c83b60cd0c88a722893c153c2b7fcf290e043dda983f679e4093bf77a173", "https://registry.npmjs.org/svelte2tsx/-/svelte2tsx-0.7.61.tgz", "package"),
    "esm-env": ("1.2.1", "a5dc7c161a9e96dc3f21d895bbfef0333ec93291db2b058d6d9d2dd23ce49cdd", "https://registry.npmjs.org/esm-env/-/esm-env-1.2.1.tgz", "package"),
    "devalue": ("5.9.2", "f2444c29d1f13194992f3dffead58dec839c98915607b9b2b43d0ce7f0543a0f", "https://registry.npmjs.org/devalue/-/devalue-5.9.2.tgz", "package"),
    "esrap": ("2.3.6", "058631fede9f8d82f8a7624394ef3365f9d37827420efaf1cbd9d135459b1744", "https://registry.npmjs.org/esrap/-/esrap-2.3.6.tgz", "package"),
    "estree": ("1.0.9", "ec8f3c0dfb21497db5a3480c45a6cf6f9b18d3b337b2ea4d03e3ef2a9c2bb358", "https://registry.npmjs.org/@types/estree/-/estree-1.0.9.tgz", "estree"),
    "sourcemap-codec": ("1.6.0", "f30a35f6af8c347d01b8ff2f8662272f7d986cf21b916704d86c249a90b97e25", "https://registry.npmjs.org/@jridgewell/sourcemap-codec/-/sourcemap-codec-1.6.0.tgz", "package"),
    "magic-string": ("0.30.11", "4277283975b40e80a97a49e8eb57d5f8028d8e34d4afd48f2a3b5430d9de74b5", "https://registry.npmjs.org/magic-string/-/magic-string-0.30.11.tgz", "package"),
    "locate-character": ("3.0.0", "a7925696d7983216a5d4f0383fbcf87b63a9bb36bca205d40fc4ccba1db12585", "https://registry.npmjs.org/locate-character/-/locate-character-3.0.0.tgz", "package"),
}

[
    shims.http_archive(
        name = name,
        sha256 = sha256,
        strip_prefix = prefix,
        type = "tar.gz",
        urls = [url],
        visibility = [],
    )
    for name, (_, sha256, url, prefix) in ARCHIVES.items()
]

svelte_runtime(
    name = "runtime",
    packages = {name: ":" + name for name in ARCHIVES} | {"clsx": "third-party//js/clsx:archive"},
    visibility = ["PUBLIC"],
)
