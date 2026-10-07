# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

def record_json(record: struct) -> dict[str, typing.Any]:
    return {
        "deps": record.deps,
        "exports": record.exports,
        "externals": record.externals,
        "import_name": record.import_name,
        "label": record.label,
        "srcs": record.srcs,
        "generated": record.generated,
        "svelte_runtime": record.svelte_runtime,
        "wasm": {
            specifier: {"module": module, "path": artifact}
            for specifier, (module, artifact) in record.wasm.items()
        },
    }

def record_srcs(record: struct) -> list[Artifact]:
    return record.srcs + [artifact for _, artifact in record.wasm.values()] + ([record.generated.directory] if record.generated else [])

# One record per library: its label, import name, exported specifiers (each
# mapped to a file), wasm specifiers (each mapped to its module name and
# file), sources and direct dependencies. The JSON projection is the closure
# a driver manifest lists; the args projection is every source and wasm
# file, which each action takes as hidden inputs.
JsLibraryTSet = transitive_set(
    args_projections = {"srcs": record_srcs},
    json_projections = {"json": record_json},
)

JsLibraryInfo = provider(
    doc = "A JavaScript/TypeScript source library: its label, import name and the transitive set of its closure.",
    fields = {
        "import_name": provider_field(str),
        # The library's own target, which dependents record: a dependency
        # written through an `alias` still names the library itself.
        "label": provider_field(str),
        "tset": provider_field(typing.Any),
        # Every wasm module of the closure: module file name to artifact.
        "wasm": provider_field(dict[str, typing.Any]),
    },
)
