# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# quad: an Emacs-like editor platform in Chez Scheme, with Ki's modal
# bindings.
#
#   kernel/   the kernel: C (kernel.c) boots Chez Scheme from boot files
#             appended to its own executable and does raw terminal and socket
#             I/O; Rust provides components, a crate each (kernel/*/), which
#             lib.rs makes the Scheme library (quad native) through the chez
#             crate
#   core/     the editor, in Scheme: the libraries (quad *)
#   core/ext/ extensions built in by default: the libraries (quad ext *)
#
# The Scheme builds with the Chez Scheme toolchain (toolchains//chez): a
# library target each for the core and every extension, the program, the
# boot file, the standalone executable.
#
#   buck2 run depot-tilde//aseipp/quad:quad -- FILE    edit FILE
#   buck2 install depot-tilde//aseipp/quad:quad        install it, in ~/.local
#   :quad                                              the standalone executable
#   :quad-custom                                       one with extra code compiled in

load("@root//buck/installers:defs.bzl", "installable", "macos_app")
load("@root//buck/shims:shims.bzl", "shims")
load("@toolchains//chez:defs.bzl", "chez")
load(":defs.bzl", "quad_executable", "slang_metal", "slang_shader")

# The extensions in core/ext/ the editor is built with, in load order, with the
# libraries each needs beyond the core.
EXTENSIONS = {
    "blake3": [":native"],
    "c": [],
    "codex": [":ext-project"],
    "grep": [":native"],
    "image": [":native"],
    "jj": [":native"],
    "ki": [],
    "vi": [],
    "vim": [":ext-vi"],
    "helix": [":ext-vi"],
    "link": [],
    "lisp": [],
    "lsp": [":ext-project"],
    "markdown": [":ext-link"],
    "mesh": [":native"],
    "people": [],
    "project": [":native"],
    "relay": [],
    "shell": [],
    "tutor": [],
    "voice": [
        ":native",
        ":ext-people",
    ],
}

# Files beside an extension's source that it includes as it compiles.
EXTENSION_DATA = {
    "tutor": [
        "core/ext/tutor.md",
        "core/ext/tutor-helix.md",
        "core/ext/tutor-vim.md",
    ],
}

EXTENSION_ORDER = [
    "ki",
    "vi",
    "vim",
    "helix",
    "link",
    "lisp",
    "c",
    "shell",
    "markdown",
    "image",
    "blake3",
    "grep",
    "project",
    "jj",
    "codex",
    "lsp",
    "people",
    "mesh",
    "relay",
    "voice",
    "tutor",
]

# MARK: Kernel

# The Rust half: a crate for each part, each built and tested on its own,
# so that a change to one rebuilds it and what uses it, not the rest. The
# kernel's own (kernel/lib.rs) is the procedures Scheme calls, (quad
# native), over the others:
#
#   kernel/timing   startup's steps, timed
#   kernel/text     buffer text (a rope) and searching it
#   kernel/diff     line diffs, for the gutter
#   kernel/files    a project's files, and grep
#   kernel/image    images: PNGs decoded and scaled
#   kernel/mesh     editors and clients over iroh
#   kernel/voice    voice over iroh
#   kernel/font     fonts, shaping, Slug's curves, color emoji
#   kernel/render   drawing frames: Vulkan, Metal
#   kernel/gui      windows, screens, screen readers, the main thread
KERNEL_CRATES = [
    "//aseipp/quad/kernel/" + crate + ":" + crate
    for crate in [
        "diff",
        "files",
        "font",
        "gui",
        "image",
        "mesh",
        "render",
        "text",
        "timing",
        "voice",
    ]
]

shims.rust_library(
    name = "kernel-rs",
    srcs = ["kernel/lib.rs"],
    crate = "quad_kernel",
    crate_root = "kernel/lib.rs",
    deps = KERNEL_CRATES + [
        "third-party//rust:blake3",
        "third-party//rust:libc",
        "third-party//rust:png",
        "//aseipp/quad/kernel/chez-rs:chez",
    ],
)

# The macOS frameworks the Rust half's crates use: they name them in their
# #[link]s, which reach the links rustc makes, but not :kernel's, which
# clang++ makes. Quartz Core and AppKit also hold classes that are looked
# up by name (CAMetalLayer, NSApplication), which only frameworks loaded
# have.
MACOS_FRAMEWORKS = [
    "AppKit",  # winit's windows, AccessKit's adapter, the pasteboard
    "AudioToolbox",  # voice's audio queues
    "Carbon",  # winit's keyboard layouts
    "CoreFoundation",
    "CoreGraphics",
    "CoreText",  # fontique's fonts
    "CoreVideo",  # winit's display links
    "Foundation",
    "Metal",
    "QuartzCore",  # CAMetalLayer
    "Security",  # TLS, under iroh
    "SystemConfiguration",  # network interfaces, under iroh
]

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
    # (kernel/exports.map, on Linux). Debug info stays in the objects (split
    # DWARF, toolchains//cxx), and :quad strips the rest into its [debug]
    # file. A Mach-O link (macOS) says the same in its own words.
    linker_flags = shims.select({
        "config//os:linux": [
            "-Wl,--version-script=$(location :kernel-exports)",
            "-Wl,--gc-sections",
        ],
        "config//os:macos": [
            "-Wl,-dead_strip",
            "-Wl,-unexported_symbol,__ZN*",
            "-Wl,-unexported_symbol,__R*",
            "-lobjc",
        ] + [
            flag
            for framework in MACOS_FRAMEWORKS
            for flag in [
                "-framework",
                framework,
            ]
        ],
    }),
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
        srcs = ["core/ext/{}.sls".format(ext)] + EXTENSION_DATA.get(ext, []),
        prefix = "quad",
        strip_prefix = "core",
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
# --prefix names another place) with its desktop entry and icon (etc/).
#
#   buck2 install -m release depot-tilde//aseipp/quad:quad
installable(
    name = "quad",
    files = {
        "bin/quad": ":quad-exe",
        "share/applications/quad.desktop": "etc/quad.desktop",
        "share/icons/hicolor/scalable/apps/quad.svg": "etc/quad.svg",
    },
    installer = "root//buck/installers/prefix:prefix",
    main = ":quad-exe",
)

# quad as a macOS app, for Finder, the Dock and Spotlight, which `buck2
# install` puts in ~/Applications (the installer's --dir names another
# place). It opens a window, on the running editor if one listens.
#
#   buck2 install -m release depot-tilde//aseipp/quad:quad.app
macos_app(
    name = "quad.app",
    executable = ":quad-exe",
    info_plist = "etc/Info.plist",
    resources = {
        "quad.icns": ":quad.icns",
    },
    target_compatible_with = ["config//os:macos"],
)

# The app's icon: etc/quad.svg at each size an icon has, drawn by macOS's
# own sips and packed by iconutil, on Apple's grid for an app's icon: the
# SVG's rounded square, 60 of its 64 units, is 824 pixels of 1024, 100 in
# from each edge.
shims.genrule(
    name = "quad.icns",
    srcs = ["etc/quad.svg"],
    out = "quad.icns",
    cmd = """
        set -e
        sed -e 's|width="64" height="64" viewBox="0 0 64 64"|width="1024" height="1024" viewBox="-5.28155 -5.28155 74.5631 74.5631"|' \
            $SRCS > $TMP/icon.svg
        if ! grep -q 'width="1024"' $TMP/icon.svg; then
            echo "etc/quad.svg: not 64 units square, as the grid here takes it" >&2
            exit 1
        fi
        /usr/bin/sips -s format png $TMP/icon.svg --out $TMP/icon.png > /dev/null
        mkdir $TMP/quad.iconset
        # Each size, and its double for Retina displays.
        for sizes in 16:32 32:64 128:256 256:512 512:1024; do
            size=${sizes%:*}
            double=${sizes#*:}
            /usr/bin/sips -z $size $size $TMP/icon.png \
                --out $TMP/quad.iconset/icon_${size}x${size}.png > /dev/null
            /usr/bin/sips -z $double $double $TMP/icon.png \
                --out $TMP/quad.iconset/icon_${size}x${size}@2x.png > /dev/null
        done
        /usr/bin/iconutil -c icns -o $OUT $TMP/quad.iconset
    """,
    target_compatible_with = ["config//os:macos"],
)

# An example of a configured editor, built with quad itself.
quad_executable(
    name = "quad-custom",
    srcs = ["docs/examples/site.ss"],
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
    srcs = glob([
        "docs/examples/*.ss",
        "docs/examples/tests/*.ss",
    ]),
)

[
    shims.command_test(
        name = "test-" + t,
        script = "$(exe :quad) -q --batch $(location :tests)/tests/{}.ss".format(t),
    )
    for t in [
        "text",
        "highlight",
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
        "tutor-vim",
        "tutor-helix",
        "people",
        "gui",
        "scroll",
        "link",
        "image",
        "loop",
        "files",
        "regions",
        "panes",
        "widgets",
        "vim",
        "helix",
    ]
]

# What the window draws, drawn with no window and checked against the
# cells (tests/gui-render.ss): on Mesa's lavapipe where it is installed,
# else any device (Metal's, on macOS), skipped where nothing can draw.
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
# the built-in font on lavapipe, or Metal on macOS; skipped elsewhere.
shims.dynamic_test(
    name = "test-golden",
    args = [
        "$(exe :quad)",
        "$(location :tests)/tests",
        "golden",
    ],
    dep = ":gui-render",
)

# The jj extension, against repositories made by third-party's jj (so that
# its version is known, and the user's jj and config are not involved).
shims.command_test(
    name = "test-jj",
    script = """
        QUAD_JJ=$(exe third-party//by-name/jj/jj:jj) $(exe :quad) -q --batch $(location :tests)/tests/jj.ss
    """,
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
        # A client that stops reading stops nobody else.
        $quad -q --batch $(location :tests)/tests/stuck.ss
        # A client of another editor switches to the daemon, and back.
        $quad -q --batch $(location :tests)/tests/relay.ss
        # The daemon is still there, and its client left it.
        test "`$quad --connect --eval '(length (clients))'`" = 1
        test "`$quad --connect --eval '(+ 1 2)'`" = 3
        # The scripted client detached; only this one remains.
        test "`$quad --connect --eval '(length (clients))'`" = 1
        # A second daemon on the same socket is refused.
        ! $quad -q --daemon > /dev/null 2>&1
        # Two daemons starting at once, where a socket was left by one that
        # is gone: one listens, the other is refused, and the one listening
        # is still reached once the other has gone.
        for i in 1 2 3 4 5; do
            race=$dir/race.sock
            rm -f $race && touch $race
            QUAD_SOCKET=$race $quad -q --daemon > $dir/race1.log 2>&1 &
            one=$!
            QUAD_SOCKET=$race $quad -q --daemon > $dir/race2.log 2>&1 &
            two=$!
            # The one refused exits; then the other must answer.
            for j in `seq 100`; do kill -0 $one 2>/dev/null && kill -0 $two 2>/dev/null || break; sleep 0.05; done
            test "`QUAD_SOCKET=$race $quad --connect --eval '(+ 1 2)'`" = 3
            QUAD_SOCKET=$race $quad --connect --eval '(editor-quit!)' > /dev/null
            wait $one || true
            wait $two || true
            test "`cat $dir/race1.log $dir/race2.log | grep -c 'already listening'`" = 1
        done
        # The default socket's directory must be this user's alone: in one
        # that others may write, quad neither listens nor connects.
        mkdir -m 755 $dir/run && mkdir -m 777 $dir/run/quad
        ! env -u QUAD_SOCKET XDG_RUNTIME_DIR=$dir/run $quad -q --daemon > $dir/open.log 2>&1
        grep -q "not this user's alone" $dir/open.log
        ! env -u QUAD_SOCKET XDG_RUNTIME_DIR=$dir/run $quad --connect --eval 1 > $dir/open.log 2>&1
        grep -q "not yours alone" $dir/open.log

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
        # No display: none named, on Linux; on macOS, whose window server a
        # test reaches as any program in the session does, none said to be.
        if [ "`uname`" = Darwin ]; then
            nodisplay="env QUAD_NO_DISPLAY=1"
        else
            nodisplay="env -u WAYLAND_DISPLAY -u DISPLAY"
        fi
        test "`$nodisplay $quad -q --eval '(gui-display?)'`" = '#f'
        test "`QUAD_NO_DISPLAY=1 $quad -q --eval '(gui-display?)'`" = '#f'
        # Without a terminal (or a window: no display) the editor refuses to
        # start, rather than hang.
        ! $nodisplay $quad -q < /dev/null > /dev/null 2>&1
        ! $quad -q --tui < /dev/null > /dev/null 2>&1
        # A window is not a daemon.
        out=`$quad -q --gui --daemon 2>&1 || true`
        grep -q 'an editor without one' <<<"$out"
        # Where no window can open (here, with no display; also wherever
        # this quad is on the toolchain's C library), the editor says so
        # and stops.
        ! $nodisplay $quad -q --gui < /dev/null > /dev/null 2>&1
        # The example init file loads, and its definitions take effect.
        export QUAD_INIT=$(location :examples)/docs/examples/init.ss
        test "`$quad --eval '(get-var (quote scroll-margin))'`" = 5
        test "`$quad --eval '(and (find-command (quote shout)) #t)'`" = '#t'
        # Unless -q says not to.
        test "`$quad -q --eval '(get-var (quote scroll-margin))'`" = 3
        # The tutor is built in, with its lessons.
        $quad --help | grep -q -- --tutor
        $quad -q --eval '(display tutor-text)' | grep -q '^# Lesson 10'
    """,
)

# An app macOS starts (from Finder, the Dock or open) has launchd for its
# parent, and starts in /: quad, so started, starts in the home directory,
# and does not detach (kernel.c). A quad whose parent is gone before it
# starts has launchd for its parent too, and stands in for one.
shims.command_test(
    name = "test-app-launch",
    script = """
        quad=$(exe :quad)
        export QUAD_SOCKET=`mktemp -u /tmp/quad-test.XXXXXX`
        home=`mktemp -d /tmp/quad-test.XXXXXX`
        home=`cd $home && pwd -P`
        trap 'rm -rf "$home"' EXIT
        probe='(list (current-directory) (kernel-launched-as-app))'
        # Started from a shell, in /, quad stays there.
        test "`cd / && $quad -q --eval "$probe"`" = '("/" 0)'
        # Started as an app is: in /, its parent gone, so launchd's child.
        # (The subshell exits at once, leaving sh, which then runs quad.)
        (
            cd /
            HOME=$home sh -c 'sleep 0.5; exec "$0" -q --eval "$1"' $quad "$probe" > $home/out &
        )
        n=0
        until [ -s $home/out ] || [ $n -ge 100 ]; do
            sleep 0.1
            n=`expr $n + 1`
        done
        test "`cat $home/out`" = "(\\"$home\\" 1)"
    """,
    target_compatible_with = ["config//os:macos"],
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

# Tests of a configuration (quad --test): the example init file's, by name
# and as tests/ beside the init file, which pass; one that fails, which
# fails the run; and without the init file (-q), which its tests need.
shims.command_test(
    name = "test-config",
    script = """
        quad=$(exe :quad)
        examples=$(location :examples)/docs/examples
        dir=`mktemp -d /tmp/quad-test.XXXXXX`
        trap 'rm -rf "$dir"' EXIT
        export QUAD_SOCKET=$dir/none HOME=$dir XDG_CONFIG_HOME=$dir/config
        QUAD_INIT=$examples/init.ss $quad --test $examples/tests/init.ss > $dir/named.log
        grep -q "4 passed, 0 failed, in 1 file" $dir/named.log
        mkdir -p $dir/config/quad/tests
        cp $examples/init.ss $dir/config/quad/init.ss
        cp $examples/tests/init.ss $dir/config/quad/tests/init.ss
        $quad --test > $dir/found.log
        grep -q "4 passed, 0 failed, in 1 file" $dir/found.log
        echo '(check "one is two" (= 1 2))' > $dir/config/quad/tests/wrong.ss
        ! $quad --test > $dir/wrong.log
        grep -q "FAIL one is two" $dir/wrong.log
        grep -q "4 passed, 1 failed, in 2 files" $dir/wrong.log
        ! $quad -q --test $dir/config/quad/tests/init.ss > $dir/bare.log
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
        # An editor's client shows the daemon over iroh, the editor going
        # on meanwhile; and no editor shows itself.
        QUAD_TICKET=$again QUAD_SOCKET=$dir/none $quad -q --batch $(location :tests)/tests/connect.ss
        $quad --connect --eval '(editor-quit!)' > /dev/null
        wait $daemon
        # An editor that goes leaves no client waiting: told to stop
        # (SIGTERM), it says goodbye and exits; killed, its clients notice
        # within seconds, not QUIC's half a minute.
        for how in TERM:3000 KILL:15000; do
            $quad -q --daemon --mesh > $dir/daemon3.log 2>&1 &
            daemon=$!
            for i in `seq 200`; do grep -q "the ticket" $dir/daemon3.log && break; sleep 0.05; done
            QUAD_TICKET=`sed -n 's/.*the ticket: quad --connect=//p' $dir/daemon3.log` QUAD_LOST_WITHIN=${how#*:} \
                QUAD_SOCKET=$dir/none $quad -q --batch $(location :tests)/tests/lost.ss > $dir/lost.log 2>&1 &
            client=$!
            for i in `seq 200`; do grep -q attached $dir/lost.log && break; sleep 0.05; done
            kill -${how%:*} $daemon
            wait $client || { cat $dir/lost.log; exit 1; }
            status=0; wait $daemon || status=$?
            test $how != TERM:3000 || test $status = 0
            rm -f $QUAD_SOCKET
        done
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
