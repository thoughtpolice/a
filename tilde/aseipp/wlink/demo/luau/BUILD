# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", depot = "shims")
load("//aseipp/wlink/demo/sdk:defs.bzl", "CXX_FLAGS", "NATIVE", "WASM", "console_application", "console_web")

LUAU_VERSION = "0.737"

# The interpreter, which is what a guest carries. The native code generator
# stays out: it emits machine code for architectures the console does not run
# on, and the console runs bytecode under the interpreter everywhere.
VM_SOURCES = [
    "lapi.cpp",
    "laux.cpp",
    "lbaselib.cpp",
    "lbitlib.cpp",
    "lbuffer.cpp",
    "lbuflib.cpp",
    "lbuiltins.cpp",
    "lclass.cpp",
    "lclasslib.cpp",
    "lcorolib.cpp",
    "ldblib.cpp",
    "ldebug.cpp",
    "ldo.cpp",
    "lfunc.cpp",
    "lgc.cpp",
    "lgcdebug.cpp",
    "linit.cpp",
    "lintlib.cpp",
    "lmathlib.cpp",
    "lmem.cpp",
    "lnumprint.cpp",
    "lobject.cpp",
    "loslib.cpp",
    "lperf.cpp",
    "lstate.cpp",
    "lstring.cpp",
    "lstrlib.cpp",
    "ltable.cpp",
    "ltablib.cpp",
    "ltm.cpp",
    "ludata.cpp",
    "lutf8lib.cpp",
    "lveclib.cpp",
    "lvector.cpp",
    "lvmexecute.cpp",
    "lvmload.cpp",
    "lvmutils.cpp",
]

VM_HEADERS = [
    "lapi.h",
    "lbuffer.h",
    "lbuiltins.h",
    "lbytecode.h",
    "lclass.h",
    "lcommon.h",
    "ldebug.h",
    "ldo.h",
    "lfunc.h",
    "lgc.h",
    "lmem.h",
    "lnumutils.h",
    "lobject.h",
    "lstate.h",
    "lstring.h",
    "ltable.h",
    "ltm.h",
    "ludata.h",
    "lvector.h",
    "lvm.h",
]

# What a program embedding the interpreter includes.
VM_PUBLIC_HEADERS = [
    "luaconf.h",
    "lua.h",
    "lualib.h",
]

# The compiler, which runs on the build machine rather than in the console:
# it reports errors by throwing, and WebAssembly here has no exceptions. The
# file lists follow Luau's own Sources.cmake.
AST_SOURCES = [
    "Allocator.cpp",
    "Ast.cpp",
    "Confusables.cpp",
    "Cst.cpp",
    "Lexer.cpp",
    "Location.cpp",
    "Parser.cpp",
    "PrettyPrinter.cpp",
]

AST_HEADERS = [
    "Allocator.h",
    "Ast.h",
    "Confusables.h",
    "Cst.h",
    "Lexer.h",
    "Location.h",
    "ParseOptions.h",
    "ParseResult.h",
    "Parser.h",
    "PrettyPrinter.h",
]

BYTECODE_SOURCES = [
    "BytecodeBuilder.cpp",
    "BytecodeDump.cpp",
    "BytecodeGraph.cpp",
    "Sccp.cpp",
]

BYTECODE_PRIVATE_HEADERS = [
    "BytecodeGraphParser.h",
    "BytecodeGraphSerializer.h",
]

BYTECODE_HEADERS = [
    "BytecodeBuilder.h",
    "BytecodeCallInliner.h",
    "BytecodeDump.h",
    "BytecodeGraph.h",
    "BytecodeOps.h",
    "BytecodeValidation.h",
    "Sccp.h",
]

COMPILER_SOURCES = [
    "BuiltinFolding.cpp",
    "Builtins.cpp",
    "Compiler.cpp",
    "ConstantFolding.cpp",
    "CostModel.cpp",
    "TableShape.cpp",
    "Types.cpp",
    "ValueTracking.cpp",
    "lcode.cpp",
]

COMPILER_PRIVATE_HEADERS = [
    "BuiltinFolding.h",
    "Builtins.h",
    "ConstantFolding.h",
    "CostModel.h",
    "TableShape.h",
    "Types.h",
    "Utils.h",
    "ValueTracking.h",
]

COMMON_SOURCES = [
    "BytecodeWire.cpp",
    "StringUtils.cpp",
    "TimeTrace.cpp",
]

COMMON_HEADERS = [
    "Bytecode.h",
    "BytecodeUtils.h",
    "BytecodeWire.h",
    "Common.h",
    "DenseHash.h",
    "ExperimentalFlags.h",
    "HashUtil.h",
    "InsertionOrderedMap.h",
    "ScopedSeenSet.h",
    "SmallVector.h",
    "StringUtils.h",
    "TimeTrace.h",
    "Variant.h",
    "VecDeque.h",
]

# The interpreter reaches into the shared headers for the bytecode format
# only; the compiler needs all of them.
VM_COMMON_HEADERS = [
    "Bytecode.h",
    "BytecodeUtils.h",
    "Common.h",
]

ARCHIVE = ":luau-source"

depot.http_archive(
    name = "luau-source",
    sha256 = "767b872f084518ca9a79b021f83b40e6a051be4c1f91dd712a949417a4e979c6",
    strip_prefix = "luau-" + LUAU_VERSION,
    sub_targets = (
        ["VM/src/" + name for name in VM_SOURCES + VM_HEADERS] +
        ["VM/include/" + name for name in VM_PUBLIC_HEADERS] +
        ["Ast/src/" + name for name in AST_SOURCES] +
        ["Ast/include/Luau/" + name for name in AST_HEADERS] +
        ["Bytecode/src/" + name for name in BYTECODE_SOURCES + BYTECODE_PRIVATE_HEADERS] +
        ["Bytecode/include/Luau/" + name for name in BYTECODE_HEADERS] +
        ["Compiler/src/" + name for name in COMPILER_SOURCES + COMPILER_PRIVATE_HEADERS] + [
            "Compiler/include/luacode.h",
            "Compiler/include/Luau/Compiler.h",
        ] + ["Common/src/" + name for name in COMMON_SOURCES] +
        ["Common/include/Luau/" + name for name in COMMON_HEADERS]
    ),
    type = "tar.gz",
    urls = ["https://github.com/luau-lang/luau/archive/refs/tags/" + LUAU_VERSION + ".tar.gz"],
)

depot.cxx_library(
    name = "vm",
    srcs = [ARCHIVE + "[VM/src/" + name + "]" for name in VM_SOURCES],
    compiler_flags = CXX_FLAGS + [
        # The interpreter raises errors by unwinding to a handler, which it
        # can do with either C++ exceptions or setjmp.
        "-DLUA_USE_LONGJMP=1",
    ],
    exported_deps = ["//aseipp/wlink/demo/sdk/libcxx"],
    exported_headers = {"" + name: ARCHIVE + "[VM/include/" + name + "]" for name in VM_PUBLIC_HEADERS} |
                       {"Luau/" + name: ARCHIVE + "[Common/include/Luau/" + name + "]" for name in VM_COMMON_HEADERS},
    header_namespace = "",
    headers = {"" + name: ARCHIVE + "[VM/src/" + name + "]" for name in VM_HEADERS} |
              {"Luau/" + name: ARCHIVE + "[Common/include/Luau/" + name + "]" for name in VM_COMMON_HEADERS},
    preferred_linkage = "static",
    target_compatible_with = WASM,
    visibility = ["PUBLIC"],
)

depot.cxx_library(
    name = "compiler",
    srcs = (
        [ARCHIVE + "[Ast/src/" + name + "]" for name in AST_SOURCES] +
        [ARCHIVE + "[Bytecode/src/" + name + "]" for name in BYTECODE_SOURCES] +
        [ARCHIVE + "[Compiler/src/" + name + "]" for name in COMPILER_SOURCES] +
        [ARCHIVE + "[Common/src/" + name + "]" for name in COMMON_SOURCES]
    ),
    exported_headers = {
        "luacode.h": ARCHIVE + "[Compiler/include/luacode.h]",
        "Luau/Compiler.h": ARCHIVE + "[Compiler/include/Luau/Compiler.h]",
    },
    header_namespace = "",
    headers = {"Luau/" + name: ARCHIVE + "[Ast/include/Luau/" + name + "]" for name in AST_HEADERS} |
              {"Luau/" + name: ARCHIVE + "[Bytecode/include/Luau/" + name + "]" for name in BYTECODE_HEADERS} |
              {"" + name: ARCHIVE + "[Bytecode/src/" + name + "]" for name in BYTECODE_PRIVATE_HEADERS} |
              {"" + name: ARCHIVE + "[Compiler/src/" + name + "]" for name in COMPILER_PRIVATE_HEADERS} |
              {"Luau/" + name: ARCHIVE + "[Common/include/Luau/" + name + "]" for name in COMMON_HEADERS},
    preferred_linkage = "static",
    visibility = [],
)

depot.cxx_binary(
    name = "compile-cart",
    srcs = ["compile_cart.cpp"],
    visibility = ["PUBLIC"],
    deps = [":compiler"],
)

depot.export_file(
    name = "embed_bytecode.py",
    src = "embed_bytecode.py",
    visibility = [],
)

depot.genrule(
    name = "smoke-bytecode",
    out = "smoke_bytecode.h",
    cmd = "$(exe :compile-cart) $(location :smoke.luau) $BUCK_SCRATCH_PATH/smoke.luauc && " +
          "python3 $(location :embed_bytecode.py) $BUCK_SCRATCH_PATH/smoke.luauc $OUT kSmokeBytecode",
)

depot.export_file(
    name = "smoke.luau",
    src = "test/smoke.luau",
    visibility = [],
)

# The interpreter as a guest sees it, run under the native runner.
console_application(
    name = "luau-test",
    srcs = ["test/vm_test.cpp"],
    compiler_flags = [
        "-fno-exceptions",
        "-fno-rtti",
    ],
    headers = {"smoke_bytecode.h": ":smoke-bytecode"},
    host_srcs = ["//aseipp/wlink/demo/sdk:host-smoke.c"],
    deps = [":vm"],
)

depot.command_test(
    name = "test-vm",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/console-luau-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :luau-test-host) --headless --frames 1 >"$out/log"
grep -q 'log 1: game: PASS luau state' "$out/log"
grep -q 'log 1: game: PASS luau load' "$out/log"
grep -q 'log 1: game: PASS luau run' "$out/log"
grep -q 'log 1: game: PASS luau errors' "$out/log"
grep -q 'log 1: game: PASS luau gc' "$out/log"
grep -q 'log 1: game: PASS luau all' "$out/log"
""",
    ],
    compatible_with = NATIVE,
)

# The native host keeps a luau/ path so its object stays apart from the SDK's
# own host.c in the binary that compiles both.
depot.export_file(
    name = "host.c",
    src = "host.c",
    out = "luau/host.c",
)

# A cart and the prelude both arrive as bytecode the application carries.
depot.export_file(
    name = "prelude.luau",
    src = "prelude.luau",
    visibility = [],
)

depot.export_file(
    name = "breakout.luau",
    src = "carts/breakout.luau",
    visibility = [],
)

depot.genrule(
    name = "prelude-bytecode",
    out = "prelude_bytecode.h",
    cmd = "$(exe :compile-cart) $(location :prelude.luau) $BUCK_SCRATCH_PATH/prelude.luauc && " +
          "python3 $(location :embed_bytecode.py) $BUCK_SCRATCH_PATH/prelude.luauc $OUT kPreludeBytecode",
)

depot.genrule(
    name = "breakout-bytecode",
    out = "cart_bytecode.h",
    cmd = "$(exe :compile-cart) $(location :breakout.luau) $BUCK_SCRATCH_PATH/cart.luauc && " +
          "python3 $(location :embed_bytecode.py) $BUCK_SCRATCH_PATH/cart.luauc $OUT kCartBytecode",
)

console_application(
    name = "breakout",
    srcs = [
        "console_api.cpp",
        "runtime.cpp",
    ],
    compiler_flags = [
        "-fno-exceptions",
        "-fno-rtti",
    ],
    headers = {
        "cart_bytecode.h": ":breakout-bytecode",
        "console_api.h": "console_api.h",
        "prelude_bytecode.h": ":prelude-bytecode",
    },
    host_srcs = [":host.c"],
    deps = [":vm"],
)

depot.export_file(
    name = "play.txt",
    src = "test/play.txt",
    visibility = [],
)

# The cart played to a fixed script. The runner's clock advances a frame per
# frame, so the run is a function of its input and the frame hash is stable.
depot.command_test(
    name = "test-breakout",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/console-breakout-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :breakout-host) --headless --frames 200 --script $(location :play.txt) \
  --dump-frame "$out/frame.ppm" >"$out/log"
grep -q 'summary frames=200 presents=200 width=256 height=256 hash=07d3683289f8053d' "$out/log"
head -c 15 "$out/frame.ppm" | grep -q '256 256'
""",
    ],
    compatible_with = NATIVE,
)

# The console pointed at a cart on disk: the runner compiles it and mounts the
# bytecode, so a cart is played without being built into anything.
depot.export_file(
    name = "splash.luau",
    src = "carts/splash.luau",
    visibility = [],
)

depot.genrule(
    name = "splash-bytecode",
    out = "cart_bytecode.h",
    cmd = "$(exe :compile-cart) $(location :splash.luau) $BUCK_SCRATCH_PATH/splash.luauc && " +
          "python3 $(location :embed_bytecode.py) $BUCK_SCRATCH_PATH/splash.luauc $OUT kCartBytecode",
)

depot.export_file(
    name = "luau_host.cpp",
    src = "luau_host.cpp",
    out = "luau/luau_host.cpp",
)

console_application(
    name = "cart-runner",
    srcs = [
        "console_api.cpp",
        "runtime.cpp",
    ],
    compiler_flags = [
        "-fno-exceptions",
        "-fno-rtti",
    ],
    headers = {
        "cart_bytecode.h": ":splash-bytecode",
        "console_api.h": "console_api.h",
        "prelude_bytecode.h": ":prelude-bytecode",
    },
    host_deps = [":compiler"],
    host_srcs = [":luau_host.cpp"],
    deps = [":vm"],
)

depot.command(
    name = "luau",
    cmd = ["$(exe :cart-runner-host)"],
    visibility = ["PUBLIC"],
)

# The carts that come with the console. They are played by the runner above
# rather than built into applications of their own: the console is the same
# program whichever cart it runs, and a cart is only bytecode, so a game is a
# source file, a recorded run, and nothing to link.
#
# Each one names the hash of the frames its recorded run produces. A cart is a
# pure function of its input here -- the runner's clock advances a frame per
# frame and the console seeds its randomness from the host, which a headless
# host derives from its seed option -- so the hash pins the whole stack, from
# the compiler through the interpreter to the rasterizer.
CARTS = {
    "tetris": "4de9c79ba918ef45",
    "shmup": "0eb3bab17c0fef7d",
    "fighter": "70006586c01517ff",
}

TITLES = {
    "tetris": "Tetris",
    "shmup": "Shmup",
    "fighter": "Fighter",
}

[
    depot.export_file(
        name = cart + ".luau",
        src = "carts/" + cart + ".luau",
        visibility = [],
    )
    for cart in CARTS
]

[
    depot.export_file(
        name = cart + ".txt",
        src = "test/" + cart + ".txt",
        visibility = [],
    )
    for cart in CARTS
]

# `buck2 run :tetris`, and the same for the rest.
[
    depot.command(
        name = cart,
        cmd = [
            "$(exe :cart-runner-host)",
            "$(location :" + cart + ".luau)",
        ],
        visibility = ["PUBLIC"],
    )
    for cart in CARTS
]

[
    depot.command_test(
        name = "test-" + cart,
        cmd = [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            """
out="${TMPDIR:-/tmp}/console-""" + cart + """-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :cart-runner-host) $(location :""" + cart + """.luau) --headless --frames 400 \
  --script $(location :""" + cart + """.txt) --dump-frame "$out/frame.ppm" >"$out/log"
grep -q 'summary frames=400 presents=400 width=256 height=256 hash=""" + CARTS[cart] + """' "$out/log"
head -c 15 "$out/frame.ppm" | grep -q '256 256'
""",
        ],
        compatible_with = NATIVE,
    )
    for cart in CARTS
]

# Both hosts, one cart: the native runner compiles it on the way in and the
# browser host gets the same bytecode mounted, and from there every traced
# frame and the summary have to agree.
[
    depot.command_test(
        name = "test-" + cart + "-web-parity",
        cmd = [
            "python3",
            "$(location //aseipp/wlink/demo:parity-test.py)",
            "luau",
            "$(exe :cart-runner-host) $(location :" + cart + ".luau)",
            "$(exe :" + cart + "-web-headless)",
        ],
        target_compatible_with = ["config//os:linux"],
    )
    for cart in CARTS
]

# The bytecode a browser gets: the same console module, with the cart mounted
# where the runtime looks for one.
[
    depot.genrule(
        name = cart + "-cart",
        out = "cart.luauc",
        cmd = "$(exe :compile-cart) $(location :" + cart + ".luau) $OUT",
    )
    for cart in CARTS
]

[
    console_web(
        name = cart,
        aspect = "frame",
        linked = ":cart-runner-linked",
        mounts = {"cart.luauc": ":" + cart + "-cart"},
        title = TITLES[cart],
    )
    for cart in CARTS
]

depot.export_file(
    name = "errors.luau",
    src = "test/errors.luau",
    visibility = [],
)

depot.genrule(
    name = "errors-cart",
    out = "cart.luauc",
    cmd = "$(exe :compile-cart) $(location :errors.luau) $OUT",
)

# The same failing cart in a browser. Raising a Lua error means throwing a
# WebAssembly exception, so this is what says that the two hosts agree about
# the mechanism and not only about the pixels.
console_web(
    name = "errors",
    aspect = "frame",
    linked = ":cart-runner-linked",
    mounts = {"cart.luauc": ":errors-cart"},
    title = "Errors",
)

depot.command_test(
    name = "test-errors-web-parity",
    cmd = [
        "python3",
        "$(location //aseipp/wlink/demo:parity-test.py)",
        "luau",
        "$(exe :cart-runner-host) $(location :errors.luau)",
        "$(exe :errors-web-headless)",
    ],
    target_compatible_with = ["config//os:linux"],
)

# What a cart may do about its own errors, and what the console does about
# the ones it does not. Both need the jumps the interpreter raises errors
# with to actually unwind, which on this target is a lowering onto the
# exception mechanism rather than anything a jump buffer holds.
depot.command_test(
    name = "test-errors",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/console-errors-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :cart-runner-host) $(location :errors.luau) --headless --frames 8 >"$out/log"
# A cart handles what it protects, and carries on afterwards.
grep -q 'handled=false message=cart:13: thrown on purpose' "$out/log"
grep -q "handled=false message=cart:19: attempt to index nil with 'field'" "$out/log"
grep -q 'total=104' "$out/log"
# What it does not protect is reported against the line that raised it, and
# the cart is stopped rather than called again for the frames that are left.
grep -q "cart: _update: cart:44: attempt to index nil with 'field'" "$out/log"
grep -q 'cart:44 function _update' "$out/log"
grep -q 'summary frames=3 ' "$out/log"
""",
    ],
    compatible_with = NATIVE,
)

depot.export_file(
    name = "broken.luau",
    src = "test/broken.luau",
    visibility = [],
)

# The cart the built-in application carries, compiled and mounted at run time
# instead. Same cart, same script, so the frames must come out identical.
depot.command_test(
    name = "test-cart-runner",
    cmd = [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        """
out="${TMPDIR:-/tmp}/console-cart-runner-$$"
mkdir -p "$out"
trap 'rm -rf "$out"' EXIT
$(exe :cart-runner-host) $(location :breakout.luau) --headless --frames 200 \
  --script $(location :play.txt) >"$out/log"
grep -q 'summary frames=200 presents=200 width=256 height=256 hash=07d3683289f8053d' "$out/log"
# Started with no cart at all, the console comes up on its own splash.
$(exe :cart-runner-host) --headless --frames 2 >"$out/splash"
grep -q 'frames=2 presents=2' "$out/splash"
# A cart that does not compile is reported instead of played.
if $(exe :cart-runner-host) $(location :broken.luau) --headless --frames 1 >"$out/bad" 2>&1; then
  echo "expected the broken cart to be refused"
  exit 1
fi
grep -q "Expected ')'" "$out/bad"
""",
    ],
    compatible_with = NATIVE,
)
