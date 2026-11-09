# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# quad: an Emacs-like editor platform in Chez Scheme, with Ki's modal
# bindings.
#
#   kernel/   the kernel: C (kernel.c) boots Chez Scheme from boot files
#             appended to its own executable and does raw terminal and socket
#             I/O; Rust (lib.rs) provides components through the chez crate,
#             as the Scheme library (quad native)
#   core/     the editor, in Scheme: the libraries (quad *)
#   ext/      extensions built in by default: the libraries (quad ext *)
#
# The Scheme builds with the Chez Scheme toolchain (toolchains//chez): a
# library target each for the core and every extension, the program, the
# boot file, the standalone executable.
#
#   buck2 run depot-tilde//aseipp/quad:quad -- FILE    edit FILE
#   buck2 install depot-tilde//aseipp/quad:quad        install it, in ~/.local
#   :quad                                              the standalone executable
#   :quad-custom                                       one with extra code compiled in

load("@root//buck/installers:defs.bzl", "installable")
load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//chez:defs.bzl", "chez")
load(":defs.bzl", "quad_executable", "slang_shader")

# The extensions in ext/ the editor is built with, in load order, with the
# libraries each needs beyond the core.
EXTENSIONS = {
    "blake3": [":native"],
    "c": [],
    "codex": [],
    "image": [":native"],
    "lisp": [],
    "lsp": [],
    "markdown": [],
    "people": [],
    "shell": [],
    "tutor": [],
    "voice": [
        ":native",
        ":ext-people",
    ],
}

# Files beside an extension's source that it includes as it compiles.
EXTENSION_DATA = {
    "tutor": ["ext/tutor.md"],
}

EXTENSION_ORDER = [
    "lisp",
    "c",
    "shell",
    "markdown",
    "image",
    "blake3",
    "codex",
    "lsp",
    "people",
    "voice",
    "tutor",
]

# MARK: Kernel

KERNEL_RS_DEPS = [
    "//aseipp/quad/chez-rs:chez",
    "third-party//rust:accesskit",
    "third-party//rust:accesskit_winit",
    "root//src/crates/accept:accept",
    "root//src/crates/iroh-dial:iroh-dial",
    "root//src/crates/iroh-mesh:iroh-mesh",
    "third-party//rust:ash",
    "third-party//rust:blake3",
    "third-party//rust:bytes",
    "third-party//rust:fontique",
    "third-party//rust:futures",
    "third-party//rust:harfrust",
    "third-party//rust:iroh",
    "third-party//rust:libc",
    "third-party//rust:png",
    "third-party//rust:skrifa",
    "third-party//rust:smithay-clipboard",
    "third-party//rust:tokio",
    "third-party//rust:unicode-width",
    "third-party//rust:winit",
    # Voice's codec (kernel/voice/opus.rs).
    "third-party//by-name/op/opus:opus",
]

KERNEL_RS_SRCS = [
    "kernel/access.rs",
    "kernel/color.rs",
    "kernel/font/cells.rs",
    "kernel/font/faces.rs",
    "kernel/font/layout.rs",
    "kernel/font/mod.rs",
    "kernel/font/sprites.rs",
    "kernel/gui/input.rs",
    "kernel/gui/mod.rs",
    "kernel/gui/snapshots.rs",
    "kernel/gui/window.rs",
    "kernel/gui/windows.rs",
    "kernel/image.rs",
    "kernel/lib.rs",
    "kernel/mesh.rs",
    "kernel/render/gpu.rs",
    "kernel/render/headless.rs",
    "kernel/render/mod.rs",
    "kernel/render/vulkan.rs",
    "kernel/render/window.rs",
    "kernel/screen.rs",
    "kernel/slug.rs",
    "kernel/timing.rs",
    "kernel/voice/mix.rs",
    "kernel/voice/mod.rs",
    "kernel/voice/opus.rs",
    "kernel/voice/pulse.rs",
]

# The GUI's shaders (kernel/gui.slang): a vertex and a fragment shader for
# each of its pipelines, beside kernel/render/mod.rs, which includes them.
GUI_SHADERS = {
    "gui.glyph.frag.spv": ("glyphFragment", "fragment"),
    "gui.glyph.vert.spv": ("glyphVertex", "vertex"),
    "gui.image.frag.spv": ("imageFragment", "fragment"),
    "gui.image.vert.spv": ("imageVertex", "vertex"),
    "gui.rect.frag.spv": ("rectFragment", "fragment"),
    "gui.rect.vert.spv": ("rectVertex", "vertex"),
}

# The window's default font, built in, beside kernel/font/mod.rs, which
# includes it.
BUILT_IN_FONTS = {
    "third-party//by-name/je/jetbrains-mono:" + style: "kernel/font/fonts/JetBrainsMono-{}.ttf".format(style)
    for style in [
        "Regular",
        "Bold",
        "Italic",
        "BoldItalic",
    ]
}

KERNEL_RS_MAPPED_SRCS = {
    ":" + out: "kernel/render/" + out
    for out in GUI_SHADERS
} | BUILT_IN_FONTS

[
    slang_shader(
        name = out,
        src = "kernel/gui.slang",
        entry = entry,
        stage = stage,
    )
    for out, (entry, stage) in GUI_SHADERS.items()
]

shims.rust_library(
    name = "kernel-rs",
    srcs = KERNEL_RS_SRCS,
    crate = "quad_kernel",
    crate_root = "kernel/lib.rs",
    mapped_srcs = KERNEL_RS_MAPPED_SRCS,
    tests = [":kernel-rs-test"],
    deps = KERNEL_RS_DEPS,
)

shims.rust_test(
    name = "kernel-rs-test",
    srcs = KERNEL_RS_SRCS,
    crate = "quad_kernel",
    crate_root = "kernel/lib.rs",
    mapped_srcs = KERNEL_RS_MAPPED_SRCS,
    # Properties, checked over generated cases (hegel).
    deps = KERNEL_RS_DEPS + ["third-party//rust:hegeltest"],
)

# (quad native): the Rust half's procedures, as kernel/lib.rs declares them.
chez.rust_library(
    name = "native",
    crate = ":kernel-rs",
    crate_name = "quad_kernel",
    library = "native",
)

shims.cxx_binary(
    name = "kernel",
    srcs = ["kernel/kernel.c"],
    compiler_flags = [
        "-std=gnu11",
        "-Wall",
        "-Wextra",
        "-Wno-unused-parameter",
        "-O2",
    ],
    # Everything is linked in, position-independently: the Rust archive too,
    # which Buck builds non-PIC for plain static linking.
    link_style = "static_pic",
    # Sections nothing refers to go: the Rust half's crates are an object
    # each (codegen-units=1), so whole crates come in for one function, and
    # this leaves the functions that are used (a quarter less code). The
    # dynamic symbol table leaves out the Rust and C++ names
    # (kernel/exports.map). Debug info stays in the objects (split DWARF,
    # toolchains//cxx), and :quad strips the rest into its [debug] file.
    linker_flags = [
        "-Wl,--version-script=$(location :kernel-exports)",
        "-Wl,--gc-sections",
    ],
    deps = [
        ":kernel-rs",
        "toolchains//chez:embed",
        "toolchains//chez:kernel",
        # malloc and free, for C, Chez Scheme and Rust alike.
        "third-party//by-name/mi/mimalloc:mimalloc-override",
    ],
)

shims.export_file(
    name = "kernel-exports",
    src = "kernel/exports.map",
)

# MARK: Scheme

chez.library(
    name = "core",
    srcs = glob(["core/*.sls"]),
    prefix = "quad",
    strip_prefix = "core",
    deps = [
        "toolchains//chez:embed-scheme",
        ":native",
    ],
)

[
    chez.library(
        name = "ext-" + ext,
        srcs = ["ext/{}.sls".format(ext)] + EXTENSION_DATA.get(ext, []),
        prefix = "quad",
        deps = [":core"] + extra,
    )
    for ext, extra in EXTENSIONS.items()
]

# The program: the editor, with its extensions.
shims.write_file(
    name = "quad.ss",
    contents = [
        ";; quad.ss -- the program, generated by BUILD from EXTENSION_ORDER",
        "(import (chezscheme) (quad main)",
    ] + ["        (quad ext {})".format(e) for e in EXTENSION_ORDER] + [
        "        )",
        ";; Nothing references an extension's exports, and a library runs only",
        ";; when something does, so each is invoked: that is when it registers",
        ";; its modes, commands and keys.",
        "(for-each invoke-library '(",
    ] + ["  (quad ext {})".format(e) for e in EXTENSION_ORDER] + [
        "  ))",
        "(suppress-greeting #t)",
        ";; The kernel calls scheme-start with the command line; the result is",
        ";; the exit status.",
        "(scheme-start",
        " (lambda args",
        "   (let ([status (quad-main args)])",
        "     (if (integer? status) status 0))))",
        "",
    ],
)

chez.program(
    name = "program",
    src = ":quad.ss",
    deps = [":ext-" + e for e in EXTENSION_ORDER],
)

# The editor's boot file, on top of Chez Scheme's petite.boot and
# scheme.boot: the compiler stays, for extensions.
chez.boot(
    name = "boot",
    strip = True,
    deps = [":program"],
)

# The kernel with the boot files appended: a single executable that needs
# nothing else at run time but, on Linux, the host's C library (glibc and
# libstdc++ at least as new as the toolchain's) in place of the
# toolchain's, since the host's Vulkan loader and GPU driver load into it
# for --gui.
chez.standalone(
    name = "quad-exe",
    out = "quad",
    boots = [":boot"],
    host = True,
    kernel = ":kernel",
)

# The executable, which `buck2 install` puts in ~/.local (the installer's
# --prefix names another place) with its desktop entry and icon (dist/).
#
#   buck2 install -m release depot-tilde//aseipp/quad:quad
installable(
    name = "quad",
    files = {
        "bin/quad": ":quad-exe",
        "share/applications/quad.desktop": "dist/quad.desktop",
        "share/icons/hicolor/scalable/apps/quad.svg": "dist/quad.svg",
    },
    installer = "root//buck/installers/prefix:prefix",
    main = ":quad-exe",
)

# An example of a configured editor, built with quad itself.
quad_executable(
    name = "quad-custom",
    srcs = ["examples/site.ss"],
)

# MARK: Tests

shims.filegroup(
    name = "tests",
    srcs = glob([
        "tests/*.ss",
        "tests/golden/*.png",
    ]),
)

shims.filegroup(
    name = "examples",
    srcs = glob(["examples/*.ss"]),
)

[
    shims.command_test(
        name = "test-" + t,
        script = "$(exe :quad) -q --batch $(location :tests)/tests/{}.ss".format(t),
    )
    for t in [
        "text",
        "graphemes",
        "selection",
        "editing",
        "keys",
        "terminal",
        "protocol",
        "clients",
        "native",
        "json",
        "tutor",
        "people",
        "gui",
        "scroll",
        "link",
        "image",
        "loop",
    ]
]

# What the window draws, drawn with no window and checked against the
# cells (tests/gui-render.ss): on Mesa's lavapipe where it is installed,
# skipped where nothing can draw.
shims.export_file(
    name = "gui-render.sh",
    src = "tests/gui-render.sh",
)

shims.command(
    name = "gui-render",
    cmd = ["$(location :gui-render.sh)"],
)

shims.dynamic_test(
    name = "test-gui-render",
    args = [
        "$(exe :quad)",
        "$(location :tests)/tests",
    ],
    dep = ":gui-render",
)

# Scenes drawn as tests/golden's images show them (tests/golden.ss), with
# the built-in font on lavapipe; skipped where there is no lavapipe.
shims.dynamic_test(
    name = "test-golden",
    args = [
        "$(exe :quad)",
        "$(location :tests)/tests",
        "golden",
    ],
    dep = ":gui-render",
)

# A daemon, and clients in other processes: a scripted one speaking the
# protocol over the socket, and --connect --eval.
shims.command_test(
    name = "test-remote",
    script = """
        quad=$(exe :quad)
        dir=`mktemp -d /tmp/quad-test.XXXXXX`
        trap 'kill $daemon 2>/dev/null || true; rm -rf "$dir"' EXIT
        export QUAD_SOCKET=$dir/quad.sock
        echo "remote content" > $dir/file.txt
        $quad -q --daemon $dir/file.txt > $dir/daemon.log 2>&1 &
        daemon=$!
        for i in `seq 100`; do test -S $QUAD_SOCKET && break; sleep 0.05; done
        test -S $QUAD_SOCKET

        $quad -q --batch $(location :tests)/tests/remote.ss
        # A client of another editor switches to the daemon, and back.
        $quad -q --batch $(location :tests)/tests/relay.ss
        # The daemon is still there, and its client left it.
        test "`$quad --connect --eval '(length (clients))'`" = 1
        test "`$quad --connect --eval '(+ 1 2)'`" = 3
        # The scripted client detached; only this one remains.
        test "`$quad --connect --eval '(length (clients))'`" = 1
        # A second daemon on the same socket is refused.
        ! $quad -q --daemon > /dev/null 2>&1

        $quad --connect --eval '(editor-quit!)' > /dev/null
        wait $daemon
        test ! -e $QUAD_SOCKET
        grep -q "listening at $QUAD_SOCKET" $dir/daemon.log
    """,
)

shims.command_test(
    name = "test-cli",
    script = """
        quad=$(exe :quad)
        # No daemon: quad would otherwise be a client of one running here.
        export QUAD_SOCKET=`mktemp -u /tmp/quad-test.XXXXXX`
        $quad --version | grep -q '^quad 0.1.0 (Chez Scheme 10.4.1)'
        test "`$quad -q --eval '(+ 1 2)'`" = 3
        # The editor's own libraries are in scope.
        test "`$quad -q --eval '(text-length (make-text "hello"))'`" = 5
        # Without a terminal (or a window: no display) the editor refuses to
        # start, rather than hang.
        ! env -u WAYLAND_DISPLAY -u DISPLAY $quad -q < /dev/null > /dev/null 2>&1
        ! $quad -q --tui < /dev/null > /dev/null 2>&1
        # A window is not a daemon.
        out=`$quad -q --gui --daemon 2>&1 || true`
        grep -q 'an editor without one' <<<"$out"
        # Where no window can open (here, with no display; also wherever
        # this quad is on the toolchain's C library), the editor says so
        # and stops.
        ! env -u WAYLAND_DISPLAY -u DISPLAY $quad -q --gui < /dev/null > /dev/null 2>&1
        # The example init file loads, and its definitions take effect.
        export QUAD_INIT=$(location :examples)/examples/init.ss
        test "`$quad --eval '(get-var (quote scroll-margin))'`" = 5
        test "`$quad --eval '(and (find-command (quote shout)) #t)'`" = '#t'
        # Unless -q says not to.
        test "`$quad -q --eval '(get-var (quote scroll-margin))'`" = 3
        # The tutor is built in, with its lessons.
        $quad --help | grep -q -- --tutor
        $quad -q --eval '(display tutor-text)' | grep -q '^# Lesson 10'
    """,
)

# The agent extension, against a stand-in for Codex's app server
# (tests/codex-server.ss, run by quad itself), with an init file of its own.
shims.command_test(
    name = "test-codex",
    script = """
        dir=`mktemp -d /tmp/quad-test.XXXXXX`
        trap 'rm -rf "$dir"' EXIT
        export QUAD_TEST_DIR=$(location :tests)/tests QUAD_INIT=$dir/init.ss
        $(exe :quad) -q --batch $QUAD_TEST_DIR/codex.ss
    """,
)

# The language server client, against a stand-in server
# (tests/lsp-server.ss, run by quad itself), in a project of its own.
shims.command_test(
    name = "test-lsp",
    script = """
        dir=`mktemp -d /tmp/quad-test.XXXXXX`
        trap 'rm -rf "$dir"' EXIT
        export QUAD_TEST_DIR=$(location :tests)/tests QUAD_LSP_DIR=$dir
        $(exe :quad) -q --batch $QUAD_TEST_DIR/lsp.ss
    """,
)

# Projects: trust, review (against the Codex stand-in), configuration,
# and a project's own language server (the LSP stand-in).
shims.command_test(
    name = "test-project",
    script = """
        dir=`mktemp -d /tmp/quad-test.XXXXXX`
        trap 'rm -rf "$dir"' EXIT
        export QUAD_TEST_DIR=$(location :tests)/tests QUAD_PROJECT_DIR=$dir QUAD_INIT=$dir/init.ss
        $(exe :quad) -q --batch $QUAD_TEST_DIR/project.ss
    """,
)

# Clients over iroh: a daemon accepting them (local: no relays or lookup,
# so the ticket's addresses reach it), a client by its ticket, and one
# with the wrong join key, refused.
shims.command_test(
    name = "test-mesh",
    script = """
        quad=$(exe :quad)
        dir=`mktemp -d /tmp/quad-test.XXXXXX`
        trap 'kill $daemon 2>/dev/null || true; rm -rf "$dir"' EXIT
        export QUAD_SOCKET=$dir/quad.sock QUAD_MESH_LOCAL=1 HOME=$dir XDG_CONFIG_HOME=$dir/config XDG_STATE_HOME=$dir/state
        test "`$quad -q --eval '(map mesh-target? (list "rock-stir-duct-feed-slick-showy" "/tmp/quad.sock" "a-b"))'`" = "(#t #f #f)"
        $quad -q --daemon --mesh > $dir/daemon.log 2>&1 &
        daemon=$!
        for i in `seq 200`; do grep -q "the ticket" $dir/daemon.log && break; sleep 0.05; done
        ticket=`sed -n 's/.*the ticket: quad --connect=//p' $dir/daemon.log`
        test -n "$ticket"
        # Only iroh reaches it: there is no socket where this client looks.
        test "`QUAD_SOCKET=$dir/none $quad --connect=$ticket --eval '(+ 1 2)'`" = 3
        test "`QUAD_SOCKET=$dir/none $quad --connect=$ticket --eval '(and (member "eval" (map client-name (clients))) #t)'`" = "#t"
        # Its credentials are kept nowhere.
        test ! -e $dir/config/quad && test ! -e $dir/state/quad
        # Another key is refused.
        bad="${ticket%.*}.0000000000000000000000000000000000000000000000000000000000000000"
        ! QUAD_SOCKET=$dir/none $quad --connect=$bad --eval 1 > $dir/bad.log 2>&1
        grep -q "join key" $dir/bad.log
        $quad --connect --eval '(editor-quit!)' > /dev/null
        wait $daemon
        # Listening again makes up new credentials.
        $quad -q --daemon --mesh > $dir/daemon2.log 2>&1 &
        daemon=$!
        for i in `seq 200`; do grep -q "the ticket" $dir/daemon2.log && break; sleep 0.05; done
        again=`sed -n 's/.*the ticket: quad --connect=//p' $dir/daemon2.log`
        test -n "$again" && test "$again" != "$ticket"
        test "`QUAD_SOCKET=$dir/none $quad --connect=$again --eval '(+ 2 2)'`" = 4
        $quad --connect --eval '(editor-quit!)' > /dev/null
        wait $daemon
    """,
)

# Voice: for this editor's own people, who leave it to switch to another
# editor (tests/voice.ss), then between a daemon and a client over iroh,
# both ways (tests/voice-link.ss). Files stand in for microphones and
# speakers.
shims.command_test(
    name = "test-voice",
    script = """
        quad=$(exe :quad)
        dir=`mktemp -d /tmp/quad-test.XXXXXX`
        trap 'kill $daemon 2>/dev/null || true; rm -rf "$dir"' EXIT
        export QUAD_SOCKET=$dir/quad.sock QUAD_MESH_LOCAL=1 HOME=$dir XDG_CONFIG_HOME=$dir/config XDG_STATE_HOME=$dir/state
        QUAD_VOICE_INPUT=$dir/host-in.raw QUAD_VOICE_OUTPUT=$dir/host-out.raw \
            $quad -q --daemon --mesh > $dir/daemon.log 2>&1 &
        daemon=$!
        for i in `seq 200`; do grep -q "the ticket" $dir/daemon.log && break; sleep 0.05; done

        QUAD_VOICE_INPUT=$dir/local-in.raw QUAD_VOICE_OUTPUT=$dir/local-out.raw \
            $quad -q --batch $(location :tests)/tests/voice.ss
        export QUAD_TICKET=`sed -n 's/.*the ticket: quad --connect=//p' $dir/daemon.log`
        test -n "$QUAD_TICKET"
        QUAD_TEST_DIR=$dir QUAD_VOICE_INPUT=$dir/client-in.raw QUAD_VOICE_OUTPUT=$dir/client-out.raw \
            $quad -q --batch $(location :tests)/tests/voice-link.ss
        $quad --connect --eval '(editor-quit!)' > /dev/null
        wait $daemon
    """,
)

# The allocator is mimalloc, through its malloc override.
shims.command_test(
    name = "test-mimalloc",
    script = """
        stats=`mktemp`
        trap 'rm -f "$stats"' EXIT
        MIMALLOC_SHOW_STATS=1 $(exe :quad) -q --eval '(make-bytevector 100000)' > "$stats" 2>&1
        # mimalloc 3.5 marks the count approximate: "malloc req~", not "malloc req:".
        grep -Eq "malloc req[:~]" "$stats"
    """,
)

# Scheme calls into the kernel's Rust half.
shims.command_test(
    name = "test-rust",
    script = """
        quad=$(exe :quad)
        $quad -q --eval '(kernel-rust-version)' | grep -q '^"quad-kernel 0.1.0 (rust)"$'
        test "`$quad -q --eval '(blake3-hex "abc")'`" = '"6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"'
    """,
)

# The configured editor carries its extra code: a command and a variable.
shims.command_test(
    name = "test-custom",
    script = """
        quad=$(exe :quad-custom)
        test "`$quad -q --eval '(get-var (quote greeting))'`" = '"hello from a custom quad"'
        test "`$quad -q --eval '(command? (find-command (quote insert-date)))'`" = '#t'
    """,
)
