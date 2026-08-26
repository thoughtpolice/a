# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")

GIT_COMMIT = "4e145b34f8ebe2ae8931af3f36d85601960d0e46"

PICOSHA2_COMMIT = "27fcf6979298949e8a462e16d09a0351c18fcaf2"

WABT_HEADERS = [
    "apply-names.h",
    "base-types.h",
    "binary-reader-ir.h",
    "binary-reader-logging.h",
    "binary-reader-nop.h",
    "binary-reader-objdump.h",
    "binary-reader-stats.h",
    "binary-reader.h",
    "binary-writer-spec.h",
    "binary-writer.h",
    "binary.h",
    "binding-hash.h",
    "c-writer.h",
    "cast.h",
    "color.h",
    "common.h",
    "error-formatter.h",
    "error.h",
    "expr-visitor.h",
    "feature.def",
    "feature.h",
    "filenames.h",
    "generate-names.h",
    "interp/binary-reader-interp.h",
    "interp/interp-inl.h",
    "interp/interp-math.h",
    "interp/interp-util.h",
    "interp/interp-wasi.h",
    "interp/interp.h",
    "interp/istream.h",
    "intrusive-list.h",
    "ir-util.h",
    "ir.h",
    "leb128.h",
    "lexer-source-line-finder.h",
    "lexer-source.h",
    "literal.h",
    "opcode-code-table.h",
    "opcode.def",
    "opcode.h",
    "option-parser.h",
    "range.h",
    "resolve-names.h",
    "result.h",
    "sha256.h",
    "shared-validator.h",
    "stream.h",
    "string-format.h",
    "string-util.h",
    "token.def",
    "token.h",
    "tracing.h",
    "type-checker.h",
    "type.h",
    "utf8.h",
    "validator.h",
    "wast-lexer.h",
    "wast-parser.h",
    "wat-writer.h",
]

WABT_LIBRARY_SOURCES = [
    "src/apply-names.cc",
    "src/binary-reader-ir.cc",
    "src/binary-reader-logging.cc",
    "src/binary-reader.cc",
    "src/binary-writer-spec.cc",
    "src/binary-writer.cc",
    "src/binary.cc",
    "src/binding-hash.cc",
    "src/c-writer.cc",
    "src/color.cc",
    "src/common.cc",
    "src/config.cc",
    "src/error-formatter.cc",
    "src/expr-visitor.cc",
    "src/feature.cc",
    "src/filenames.cc",
    "src/generate-names.cc",
    "src/interp/binary-reader-interp.cc",
    "src/interp/interp-util.cc",
    "src/interp/interp.cc",
    "src/interp/istream.cc",
    "src/ir-util.cc",
    "src/ir.cc",
    "src/leb128.cc",
    "src/lexer-source-line-finder.cc",
    "src/lexer-source.cc",
    "src/literal.cc",
    "src/opcode.cc",
    "src/option-parser.cc",
    "src/prebuilt/wasm2c_atomicops_source_declarations.cc",
    "src/prebuilt/wasm2c_header_bottom.cc",
    "src/prebuilt/wasm2c_header_top.cc",
    "src/prebuilt/wasm2c_simd_source_declarations.cc",
    "src/prebuilt/wasm2c_source_declarations.cc",
    "src/prebuilt/wasm2c_source_includes.cc",
    "src/resolve-names.cc",
    "src/sha256.cc",
    "src/shared-validator.cc",
    "src/stream.cc",
    "src/token.cc",
    "src/tracing.cc",
    "src/type-checker.cc",
    "src/utf8.cc",
    "src/validator.cc",
    "src/wast-lexer.cc",
    "src/wast-parser.cc",
    "src/wat-writer.cc",
]

TOOL_SOURCES = {
    "spectest-interp": ["src/tools/spectest-interp.cc"],
    "wasm-interp": ["src/tools/wasm-interp.cc"],
    "wasm-objdump": [
        "src/tools/wasm-objdump.cc",
        "src/binary-reader-objdump.cc",
    ],
    "wasm-stats": [
        "src/tools/wasm-stats.cc",
        "src/binary-reader-stats.cc",
    ],
    "wasm-strip": ["src/tools/wasm-strip.cc"],
    "wasm-validate": ["src/tools/wasm-validate.cc"],
    "wasm2c": ["src/tools/wasm2c.cc"],
    "wasm2wat": ["src/tools/wasm2wat.cc"],
    "wast2json": ["src/tools/wast2json.cc"],
    "wat-desugar": ["src/tools/wat-desugar.cc"],
    "wat2wasm": ["src/tools/wat2wasm.cc"],
}

WABT_ARCHIVE_FILES = (
    ["include/wabt/{}".format(header) for header in WABT_HEADERS] +
    WABT_LIBRARY_SOURCES + [
        "src/opcode-code-table.c",
        "src/prebuilt/lexer-keywords.cc",
    ] + [source for sources in TOOL_SOURCES.values() for source in sources]
)

shims.http_archive(
    name = "src",
    sha256 = "07934cf2946ee1d0c8959ac9e736f74644c246637148148f091b39660c878cd5",
    strip_prefix = "wabt-{}".format(GIT_COMMIT),
    sub_targets = WABT_ARCHIVE_FILES,
    type = "tar.gz",
    urls = [
        "https://github.com/WebAssembly/wabt/archive/{}.tar.gz".format(GIT_COMMIT),
    ],
)

shims.http_archive(
    name = "picosha2-src",
    sha256 = "18d82bb79c021ccf4ce58125b64691accef54237ba5194462740bacf8b39d8a9",
    strip_prefix = "PicoSHA2-{}".format(PICOSHA2_COMMIT),
    sub_targets = ["picosha2.h"],
    type = "tar.gz",
    urls = [
        "https://github.com/okdshin/PicoSHA2/archive/{}.tar.gz".format(PICOSHA2_COMMIT),
    ],
)

WABT_EXPORTED_HEADERS = {
    "wabt/{}".format(header): ":src[include/wabt/{}]".format(header)
    for header in WABT_HEADERS
} | {
    "wabt/config.h": "config.h",
}

WABT_CXX_FLAGS = shims.select({
    "config//os:windows": [
        "/std:c++20",
        "/W3",
        "/wd4018",
        "/wd4056",
        "/wd4244",
        "/wd4267",
        "/wd4756",
        "/wd4800",
    ],
    "DEFAULT": [
        "-std=c++20",
        "-Wall",
        "-Wextra",
        "-Wimplicit-fallthrough",
        "-Wno-unused-parameter",
        "-Wold-style-cast",
        "-Wpointer-arith",
        "-Wuninitialized",
        "-fno-exceptions",
    ],
})

WABT_PREPROCESSOR_FLAGS = [
    "-D__STDC_FORMAT_MACROS=1",
    "-D__STDC_LIMIT_MACROS=1",
] + shims.select({
    "config//os:windows": [
        "-D_CRT_SECURE_NO_WARNINGS",
        "-D_HAS_EXCEPTIONS=0",
        "-D_SCL_SECURE_NO_WARNINGS",
    ],
    "DEFAULT": [],
})

# This source is intentionally C: it uses designated array initializers that
# are not available in the C++ language mode used by the rest of WABT.
shims.cxx_library(
    name = "opcode-code-table",
    srcs = [":src[src/opcode-code-table.c]"],
    header_namespace = "",
    headers = WABT_EXPORTED_HEADERS,
    preferred_linkage = "static",
    preprocessor_flags = WABT_PREPROCESSOR_FLAGS,
)

shims.cxx_library(
    name = "wabt",
    srcs = [":src[{}]".format(source) for source in WABT_LIBRARY_SOURCES],
    compiler_flags = WABT_CXX_FLAGS,
    exported_headers = WABT_EXPORTED_HEADERS,
    header_namespace = "",
    headers = {
        "picosha2.h": ":picosha2-src[picosha2.h]",
        "prebuilt/lexer-keywords.cc": ":src[src/prebuilt/lexer-keywords.cc]",
    },
    preferred_linkage = "static",
    preprocessor_flags = WABT_PREPROCESSOR_FLAGS,
    visibility = ["PUBLIC"],
    deps = [":opcode-code-table"],
)

MATH_LINKER_FLAGS = shims.select({
    "config//os:windows": [],
    "DEFAULT": ["-lm"],
})

WABT_LINKER_FLAGS = shims.select({
    "config//os:windows": ["/STACK:8388608"],
    "DEFAULT": [],
})

[
    shims.cxx_binary(
        name = name,
        srcs = [":src[{}]".format(source) for source in sources],
        compiler_flags = WABT_CXX_FLAGS,
        link_style = "static",
        linker_flags = WABT_LINKER_FLAGS + (MATH_LINKER_FLAGS if name in [
            "spectest-interp",
            "wasm-interp",
        ] else []),
        preprocessor_flags = WABT_PREPROCESSOR_FLAGS,
        visibility = ["PUBLIC"],
        deps = [
            "third-party//by-name/mi/mimalloc:mimalloc-override",
            ":wabt",
        ],
    )
    for name, sources in TOOL_SOURCES.items()
]

[
    shims.command_test(
        name = "test-{}-version".format(name),
        cmd = [
            "$(exe :{})".format(name),
            "--version",
        ],
    )
    for name in TOOL_SOURCES.keys()
]

shims.export_file(
    name = "smoke-wat",
    src = "smoke.wat",
)

shims.export_file(
    name = "smoke-wast",
    src = "smoke.wast",
)

shims.export_file(
    name = "roundtrip-wat",
    src = "roundtrip.wat",
)

shims.export_file(
    name = "invalid-wat",
    src = "invalid.wat",
)

BASH_TEST = [
    "bash",
    "-euo",
    "pipefail",
    "-c",
]

shims.command_test(
    name = "test-tool-suite",
    cmd = BASH_TEST + [
        """
workdir="${TMPDIR:-/tmp}/wabt-smoke-$$"
mkdir -p "$workdir"
trap 'rm -rf "$workdir"' EXIT

wat="$(location :smoke-wat)"
wast="$(location :smoke-wast)"
wasm="$workdir/smoke.wasm"

$(exe :wat2wasm) "$wat" -o "$wasm"
$(exe :wasm-validate) "$wasm"
$(exe :wasm2wat) "$wasm" -o "$workdir/roundtrip.wat"
$(exe :wasm-interp) "$wasm" --run-all-exports
$(exe :wasm-objdump) -h "$wasm"
$(exe :wasm-stats) "$wasm"
$(exe :wasm-strip) "$wasm" -o "$workdir/stripped.wasm"
$(exe :wasm2c) "$wasm" -o "$workdir/smoke.c"
$(exe :wat-desugar) "$wat" -o "$workdir/desugared.wat"

$(exe :wast2json) "$wast" -o "$workdir/smoke.json"
$(exe :spectest-interp) "$workdir/smoke.json"
""",
    ],
)

shims.command_test(
    name = "test-mimalloc-override",
    cmd = BASH_TEST + [
        """
workdir="${TMPDIR:-/tmp}/wabt-mimalloc-$$"
mkdir -p "$workdir"
trap 'rm -rf "$workdir"' EXIT

for tool in \
  "$(exe :spectest-interp)" \
  "$(exe :wasm-interp)" \
  "$(exe :wasm-objdump)" \
  "$(exe :wasm-stats)" \
  "$(exe :wasm-strip)" \
  "$(exe :wasm-validate)" \
  "$(exe :wasm2c)" \
  "$(exe :wasm2wat)" \
  "$(exe :wast2json)" \
  "$(exe :wat-desugar)" \
  "$(exe :wat2wasm)"
do
  MIMALLOC_SHOW_STATS=1 "$tool" --version >"$workdir/stats" 2>&1
  grep -q "malloc req:" "$workdir/stats"
done
""",
    ],
)

shims.command_test(
    name = "test-binary-roundtrip",
    cmd = BASH_TEST + [
        """
workdir="${TMPDIR:-/tmp}/wabt-roundtrip-$$"
mkdir -p "$workdir"
trap 'rm -rf "$workdir"' EXIT

wat="$(location :roundtrip-wat)"
first="$workdir/first.wasm"
second="$workdir/second.wasm"

$(exe :wat2wasm) "$wat" -o "$first"
$(exe :wasm2wat) "$first" -o "$workdir/roundtrip.wat"
$(exe :wat2wasm) "$workdir/roundtrip.wat" -o "$second"
cmp "$first" "$second"

$(exe :wasm-interp) "$first" --run-export=answer >"$workdir/interp.out"
grep -q "answer() => i32:42" "$workdir/interp.out"
$(exe :wasm-objdump) -h "$first" >"$workdir/sections.out"
grep -q "Memory" "$workdir/sections.out"
grep -q "Data" "$workdir/sections.out"
$(exe :wasm-stats) "$first" >"$workdir/stats.out"
grep -q "Total opcodes:" "$workdir/stats.out"
""",
    ],
)

shims.command_test(
    name = "test-invalid-inputs",
    cmd = BASH_TEST + [
        """
workdir="${TMPDIR:-/tmp}/wabt-invalid-$$"
mkdir -p "$workdir"
trap 'rm -rf "$workdir"' EXIT

wat="$(location :invalid-wat)"
if $(exe :wat2wasm) "$wat" -o "$workdir/rejected.wasm"; then
  echo "wat2wasm unexpectedly accepted an invalid module" >&2
  exit 1
fi

$(exe :wat2wasm) --no-check "$wat" -o "$workdir/invalid.wasm"
if $(exe :wasm-validate) "$workdir/invalid.wasm"; then
  echo "wasm-validate unexpectedly accepted an invalid module" >&2
  exit 1
fi
""",
    ],
)

shims.command_test(
    name = "test-strip-name-section",
    cmd = BASH_TEST + [
        """
workdir="${TMPDIR:-/tmp}/wabt-strip-$$"
mkdir -p "$workdir"
trap 'rm -rf "$workdir"' EXIT

$(exe :wat2wasm) --debug-names "$(location :roundtrip-wat)" -o "$workdir/named.wasm"
$(exe :wasm-objdump) -h "$workdir/named.wasm" >"$workdir/before.out"
grep -q 'Custom.*"name"' "$workdir/before.out"

$(exe :wasm-strip) "$workdir/named.wasm" -o "$workdir/stripped.wasm"
$(exe :wasm-validate) "$workdir/stripped.wasm"
$(exe :wasm-objdump) -h "$workdir/stripped.wasm" >"$workdir/after.out"
if grep -q 'Custom.*"name"' "$workdir/after.out"; then
  echo "wasm-strip did not remove the name section" >&2
  exit 1
fi
""",
    ],
)

shims.command_test(
    name = "test-generated-outputs",
    cmd = BASH_TEST + [
        """
workdir="${TMPDIR:-/tmp}/wabt-generated-$$"
mkdir -p "$workdir"
trap 'rm -rf "$workdir"' EXIT

wat="$(location :roundtrip-wat)"
$(exe :wat-desugar) --generate-names "$wat" -o "$workdir/desugared.wat"
$(exe :wat2wasm) "$workdir/desugared.wat" -o "$workdir/desugared.wasm"
$(exe :wasm-validate) "$workdir/desugared.wasm"

$(exe :wasm2c) -n roundtrip "$workdir/desugared.wasm" -o "$workdir/roundtrip.c"
test -s "$workdir/roundtrip.c"
test -s "$workdir/roundtrip.h"
grep -q "w2c_roundtrip_answer" "$workdir/roundtrip.c"
grep -q "w2c_roundtrip_add" "$workdir/roundtrip.h"
""",
    ],
)
