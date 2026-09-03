# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""Build console applications as components and native wasm2c runners."""

load("@root//buck/shims:shims.bzl", depot = "shims")

SDK = "tilde//aseipp/wlink/demo/sdk"
WASM = ["toolchains//cfg/target:target[wasm32-unknown-unknown]"]

# The operating systems the native runner, the terminal, and their tests build
# on, for `compatible_with`: the code is POSIX with a termios terminal.
NATIVE = ["config//os:linux", "config//os:macos"]

# ld64 resolves an undefined symbol against the inputs in command-line order,
# and the SDK's libm.tbd stub lists some of the table names musl's math code
# uses internally. With -lm ahead of a static archive, a member loaded for
# one of those names binds to the stub instead of the archive and the link
# fails, so the library goes after the inputs, where a library belongs.
LIBM = ["-lm"]
REACTOR_FLAGS = ["-Zexport-executable-symbols", "-Clink-arg=--no-entry"]

# WebAssembly cannot return into a stack it has left, so setjmp and longjmp
# are lowered onto the exception mechanism instead: `-wasm-enable-sjlj` turns
# a function that calls setjmp into one that catches the `__c_longjmp` tag the
# SDK's libc throws. The legacy encoding of that mechanism is the compiler's
# default and is on its way out of browsers; the console takes the standard
# one, `try_table`, which is also the only one wedge implements.
EXCEPTION_FLAGS = [
    "-mllvm",
    "-wasm-enable-sjlj",
    "-mllvm",
    "-wasm-use-legacy-eh=false",
]

C_FLAGS = ["--target=wasm32-unknown-unknown", "-ffreestanding", "-fno-math-errno", "-fno-strict-aliasing", "-fwrapv", "-O2"] + EXCEPTION_FLAGS

# C++ guests get no runtime type information, and no exceptions unless they
# ask: unwind tables are emitted for every function that could be unwound
# through, which most guests never need. The SDK's libcxx carries the runtime
# for the ones that do, and they take CXX_EXCEPTION_FLAGS instead of these.
CXX_FLAGS = C_FLAGS + ["-fno-exceptions", "-fno-rtti"]
CXX_EXCEPTION_FLAGS = C_FLAGS + ["-fwasm-exceptions", "-fno-rtti"]

def _component(name, world):
    depot.cross_target_binary(
        name = name + "-core.wasm",
        actual = ":" + name + "-core",
        triple = "wasm32-unknown-unknown",
        visibility = ["PUBLIC"],
    )
    depot.genrule(
        name = name + ".wasm",
        out = name + ".wasm",
        cmd = "$(exe tilde//aseipp/wlink:wlink) componentize $(location :" + name + "-core.wasm) " +
              "--wit $(location " + SDK + ":sdk.wit) " +
              ("--wit $(location " + SDK + ":hal.wit) " if world == "platform" else "") +
              "--world " + world + " -o $OUT",
        visibility = ["PUBLIC"],
    )

def console_rust_component(name, src, world = "game", modules = {}):
    """A Rust implementation of the generated game or platform Guest traits.

    modules maps further source files to the module file names main.rs
    declares them as."""
    depot.rust_binary(
        name = name + "-core",
        mapped_srcs = {
            src: "main.rs",
            SDK + "/bindings:" + world + "-rust": "bindings.rs",
            SDK + ":rust_runtime.rs": "runtime.rs",
        } | modules,
        crate_root = "main.rs",
        rustc_flags = REACTOR_FLAGS,
        target_compatible_with = WASM,
        visibility = [],
        # wasm guests use std's allocator; mimalloc is a native allocator.
        deps = ["third-party//rust:bitflags"],
    )
    _component(name, world)

def console_c_component(name, srcs, headers = {}, compiler_flags = [], initial_memory = 33554432, deps = []):
    """A freestanding C game implementing console_guest_init/frame."""
    depot.cxx_library(
        name = name + "-engine",
        srcs = srcs,
        compiler_flags = C_FLAGS + compiler_flags,
        header_namespace = "",
        headers = headers,
        preferred_linkage = "static",
        target_compatible_with = WASM,
        visibility = [],
        deps = [SDK + ":c"] + deps,
    )
    depot.rust_binary(
        name = name + "-core",
        mapped_srcs = {SDK + ":runtime.rs": "main.rs"},
        crate_root = "main.rs",
        link_style = "static",
        rustc_flags = REACTOR_FLAGS + [
            "-Copt-level=2",
            "-Clink-arg=-z",
            "-Clink-arg=stack-size=1048576",
            "-Clink-arg=--initial-memory={}".format(initial_memory),
            "-Clink-arg=--max-memory=268435456",
        ],
        target_compatible_with = WASM,
        visibility = [],
        deps = [":" + name + "-engine"],
    )
    _component(name, "game")

# The linked module is optimized before it is translated. Neither half of it
# was compiled knowing the other -- the game and the platform were separate
# modules until wlink put them together -- so an optimizer that sees the whole
# thing still has work to do, and everything it removes is C that nobody has
# to write, compile or link.
#
# The features are named one at a time rather than with `-all`, which also
# turns on binaryen's own extensions: with those enabled it rewrites the
# imports into a form wasm2c will not read, and introduces SIMD that wasm2c
# then wants a vector library to translate. This list is what wlink emits.
WASM_OPT_FEATURES = " ".join([
    "--enable-exception-handling",
    "--enable-bulk-memory",
    "--enable-bulk-memory-opt",
    "--enable-sign-ext",
    "--enable-mutable-globals",
    "--enable-nontrapping-float-to-int",
    "--enable-reference-types",
    "--enable-multivalue",
    "--enable-tail-call",
    "--enable-extended-const",
    "--enable-multimemory",
])

# wasm2c writes one C function for every function in the module, and a linked
# application is a third of a million lines of them, so compiling that file is
# by far the longest step in building a host. Asking for the translation in
# several files instead lets the C compiler take them at once.
WASM2C_PARTS = 16

# Functions that shared a file could inline into each other and now cannot, so
# the host is built with ThinLTO to give that back. The import limit has to be
# raised to get all of it: wasm2c writes long bodies, and a body past the limit
# is never imported, which leaves a cart running noticeably slower than it did
# when the interpreter was one file.
LTO_COMPILER_FLAGS = ["-flto=thin"]

LTO_LINKER_FLAGS = ["-flto=thin"] + depot.select({
    "DEFAULT": ["-Wl,--plugin-opt=-import-instr-limit=1000"],
    "config//os:macos": ["-Wl,-mllvm,-import-instr-limit=1000"],
})

def console_link(name, game):
    """Link a game with the SDK platform and generate its C and HAL headers."""
    depot.genrule(
        name = name + ".wasm",
        out = "linked.wasm",
        cmd = "$(exe tilde//aseipp/wlink:wlink) link -o $OUT " +
              "platform=$(location " + SDK + ":platform.wasm) game=$(location " + game + ")",
        visibility = ["PUBLIC"],
    )

    # Only the native path takes this: the browser is served what wlink wrote,
    # so the parity tests compare the optimized module against the one it was
    # optimized from, frame by frame.
    depot.genrule(
        name = name + "-opt.wasm",
        out = "linked-opt.wasm",
        cmd = "$(exe third-party//by-name/bi/binaryen:wasm-opt) " + WASM_OPT_FEATURES +
              " -O3 $(location :" + name + ".wasm) -o $OUT",
        visibility = ["PUBLIC"],
    )
    depot.genrule(
        name = name + "-c",
        outs = {
            "c": ["linked_{}.c".format(part) for part in range(WASM2C_PARTS)],
            "h": ["linked.h"],
            "impl": ["linked-impl.h"],
            "hal": ["hal-host.h"],
        },
        cmd = "$(exe third-party//by-name/wa/wabt:wasm2c) $(location :" + name + "-opt.wasm) " +
              "-n linked --num-outputs={} -o $OUT/linked.c && ".format(WASM2C_PARTS) +
              "python3 $(location " + SDK + ":host_bindings.py) $OUT/linked.h $OUT/hal-host.h",
        default_outs = ["linked_0.c"],
        visibility = ["PUBLIC"],
    )

def console_host(name, linked, srcs, host_deps = []):
    """A native runner whose application supplies console_host_config."""
    depot.cxx_binary(
        name = name,
        srcs = srcs + [SDK + ":host.c", linked + "-c[c]"],
        compiler_flags = ["-O2"] + LTO_COMPILER_FLAGS,
        compatible_with = NATIVE,
        header_namespace = "",
        headers = {
            "linked.h": linked + "-c[h]",
            "linked-impl.h": linked + "-c[impl]",
            "hal-host.h": linked + "-c[hal]",
        },
        linker_flags = LTO_LINKER_FLAGS,
        post_linker_flags = LIBM,
        visibility = ["PUBLIC"],
        deps = [SDK + ":terminal", "third-party//by-name/wa/wabt:wasm-rt"] + host_deps,
    )

def console_application(name, srcs, host_srcs, headers = {}, compiler_flags = [], initial_memory = 33554432, deps = [], host_deps = []):
    """Compile C, componentize, link the platform, and build a native host."""
    console_c_component(name, srcs, headers, compiler_flags, initial_memory, deps)
    console_link(name + "-linked", ":" + name + ".wasm")
    console_host(name + "-host", ":" + name + "-linked", host_srcs, host_deps)

WEB = SDK + "/web"

def _quoted(value, what):
    if "'" in value:
        fail("a {} may not contain a single quote: {}".format(what, value))
    return "'" + value + "'"

def console_web(
        name,
        linked,
        mounts = {},
        option = None,
        frames_per_second = 60,
        args = [],
        title = None,
        aspect = "4:3",
        cacheable = True,
        module = None):
    """Package a linked application as a directory a browser can open.

    The result holds the browser host, the optimized module and every mounted
    asset at the virtual path the guest opens it by. `option` names the runner
    option that replaces the single mount, as the native `--iwad` does.

    The browser is served the same module the native host is translated from,
    so a page costs a fifth less to fetch than what wlink wrote. `module`
    names another module to serve instead, for a linked game that wasm-opt
    cannot take (one on the GC heap).
    """
    package = name + "-web"
    module = module or linked + "-opt.wasm"
    mount_arguments = ["--mount " + _quoted(path, "mount path") + "=$(location " + target + ")" for path, target in mounts.items()]
    depot.genrule(
        name = package,
        out = package,
        cacheable = cacheable,
        cmd = " ".join([
                           "python3 $(location " + WEB + ":web_package.py) $OUT",
                           "--name " + _quoted(name, "name"),
                           "--title " + _quoted(title or name, "title"),
                           "--frames-per-second " + str(frames_per_second),
                           "--aspect " + _quoted(aspect, "aspect"),
                           "--module $(location " + module + ")",
                           "--script $(location " + WEB + ":console)",
                           "--worklet $(location " + WEB + ":worklet)",
                           "--index $(location " + WEB + ":index.html)",
                       ] + (["--option " + _quoted(option, "option")] if option else []) +
                       mount_arguments +
                       ["--arg " + _quoted(argument, "argument") for argument in args]),
        visibility = ["PUBLIC"],
    )

    # A Deno RunInfo is several arguments, and `$(exe)` inside an argument
    # renders them space-joined, so the runnable is wrapped as a dep instead.
    depot.command(
        name = package + "-serve",
        args = ["$(location :" + package + ")"],
        dep = WEB + ":serve",
        visibility = ["PUBLIC"],
    )
    depot.command(
        name = package + "-headless",
        args = [
            "--package",
            "$(location :" + package + ")",
        ],
        dep = WEB + ":headless",
        visibility = ["PUBLIC"],
    )
    depot.command_test(
        name = "test-" + package + "-package",
        cmd = [
            "python3",
            "$(location " + WEB + ":web_package.py)",
            "--check",
            "$(location :" + package + ")",
            "--module",
            "$(location " + module + ")",
        ] + [
            argument
            for path, target in mounts.items()
            for argument in ["--mount", path + "=$(location " + target + ")"]
        ],
    )
