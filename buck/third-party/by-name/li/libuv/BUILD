# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

# The source lists and flags follow CMakeLists.txt, which upstream treats as
# the reference build: uv_sources, uv_defines and uv_libraries for each
# platform, and uv_test_sources for the uv_run_tests_a test runner.

PUBLIC_HEADERS = [
    "uv.h",
    "uv/aix.h",
    "uv/bsd.h",
    "uv/darwin.h",
    "uv/errno.h",
    "uv/linux.h",
    "uv/os390.h",
    "uv/posix.h",
    "uv/sunos.h",
    "uv/threadpool.h",
    "uv/tree.h",
    "uv/unix.h",
    "uv/version.h",
    "uv/win.h",
]

# Relative to src/, which upstream puts on the include path. The sources in
# src/unix name their own headers without the directory, which a compiler
# only finds next to the including file when the whole tree is there; the
# sandbox has just the declared inputs, so those are mapped by bare name too.
PRIVATE_HEADERS = [
    "heap-inl.h",
    "idna.h",
    "queue.h",
    "strscpy.h",
    "strtok.h",
    "unix/darwin-stub.h",
    "unix/darwin-syscalls.h",
    "unix/internal.h",
    "uv-common.h",
]

COMMON_SRCS = [
    "src/fs-poll.c",
    "src/idna.c",
    "src/inet.c",
    "src/random.c",
    "src/strscpy.c",
    "src/strtok.c",
    "src/thread-common.c",
    "src/threadpool.c",
    "src/timer.c",
    "src/uv-common.c",
    "src/uv-data-getter-setters.c",
    "src/version.c",
    "src/unix/async.c",
    "src/unix/core.c",
    "src/unix/dl.c",
    "src/unix/fs.c",
    "src/unix/getaddrinfo.c",
    "src/unix/getnameinfo.c",
    "src/unix/loop-watcher.c",
    "src/unix/loop.c",
    "src/unix/pipe.c",
    "src/unix/poll.c",
    "src/unix/process.c",
    "src/unix/proctitle.c",
    "src/unix/random-devurandom.c",
    "src/unix/signal.c",
    "src/unix/stream.c",
    "src/unix/tcp.c",
    "src/unix/thread.c",
    "src/unix/tty.c",
    "src/unix/udp.c",
]

LINUX_SRCS = [
    "src/unix/linux.c",
    "src/unix/procfs-exepath.c",
    "src/unix/random-getrandom.c",
    "src/unix/random-sysctl-linux.c",
]

MACOS_SRCS = [
    "src/unix/bsd-ifaddrs.c",
    "src/unix/darwin-proctitle.c",
    "src/unix/darwin.c",
    "src/unix/fsevents.c",
    "src/unix/kqueue.c",
    "src/unix/random-getentropy.c",
]

TEST_SRCS = [
    "test/blackhole-server.c",
    "test/echo-server.c",
    "test/runner.c",
    "test/runner-unix.c",
    "test/run-tests.c",
    "test/test-active.c",
    "test/test-async.c",
    "test/test-async-null-cb.c",
    "test/test-barrier.c",
    "test/test-callback-stack.c",
    "test/test-close-fd.c",
    "test/test-close-order.c",
    "test/test-condvar.c",
    "test/test-connection-fail.c",
    "test/test-connect-unspecified.c",
    "test/test-cwd-and-chdir.c",
    "test/test-default-loop-close.c",
    "test/test-delayed-accept.c",
    "test/test-dlerror.c",
    "test/test-eintr-handling.c",
    "test/test-embed.c",
    "test/test-emfile.c",
    "test/test-env-vars.c",
    "test/test-error.c",
    "test/test-fail-always.c",
    "test/test-fork.c",
    "test/test-fs.c",
    "test/test-fs-copyfile.c",
    "test/test-fs-event.c",
    "test/test-fs-fd-hash.c",
    "test/test-fs-open-flags.c",
    "test/test-fs-poll.c",
    "test/test-fs-readdir.c",
    "test/test-getaddrinfo.c",
    "test/test-get-currentexe.c",
    "test/test-gethostname.c",
    "test/test-get-loadavg.c",
    "test/test-get-memory.c",
    "test/test-getnameinfo.c",
    "test/test-get-passwd.c",
    "test/test-getsockname.c",
    "test/test-getters-setters.c",
    "test/test-gettimeofday.c",
    "test/test-handle-fileno.c",
    "test/test-homedir.c",
    "test/test-hrtime.c",
    "test/test-idle.c",
    "test/test-idna.c",
    "test/test-io-64-safe.c",
    "test/test-iouring-pollhup.c",
    "test/test-ip4-addr.c",
    "test/test-ip6-addr.c",
    "test/test-ipc.c",
    "test/test-ipc-heavy-traffic-deadlock-bug.c",
    "test/test-ipc-send-recv.c",
    "test/test-ip-name.c",
    "test/test-loop-alive.c",
    "test/test-loop-close.c",
    "test/test-loop-configure.c",
    "test/test-loop-handles.c",
    "test/test-loop-oom.c",
    "test/test-loop-stop.c",
    "test/test-loop-time.c",
    "test/test-metrics.c",
    "test/test-multiple-listen.c",
    "test/test-mutexes.c",
    "test/test-not-readable-nor-writable-on-read-error.c",
    "test/test-not-writable-after-shutdown.c",
    "test/test-osx-resident-set-memory.c",
    "test/test-osx-select.c",
    "test/test-pass-always.c",
    "test/test-ping-pong.c",
    "test/test-pipe-bind-error.c",
    "test/test-pipe-close-stdout-read-stdin.c",
    "test/test-pipe-connect-error.c",
    "test/test-pipe-connect-multiple.c",
    "test/test-pipe-connect-prepare.c",
    "test/test-pipe-getsockname.c",
    "test/test-pipe-pending-instances.c",
    "test/test-pipe-sendmsg.c",
    "test/test-pipe-server-close.c",
    "test/test-pipe-set-fchmod.c",
    "test/test-pipe-set-non-blocking.c",
    "test/test-pipe-write.c",
    "test/test-platform-output.c",
    "test/test-poll.c",
    "test/test-poll-close.c",
    "test/test-poll-close-doesnt-corrupt-stack.c",
    "test/test-poll-closesocket.c",
    "test/test-poll-multiple-handles.c",
    "test/test-poll-oob.c",
    "test/test-process-priority.c",
    "test/test-process-title.c",
    "test/test-process-title-threadsafe.c",
    "test/test-queue-foreach-delete.c",
    "test/test-random.c",
    "test/test-readable-on-eof.c",
    "test/test-ref.c",
    "test/test-run-nowait.c",
    "test/test-run-once.c",
    "test/test-semaphore.c",
    "test/test-shutdown-close.c",
    "test/test-shutdown-eof.c",
    "test/test-shutdown-simultaneous.c",
    "test/test-shutdown-twice.c",
    "test/test-signal.c",
    "test/test-signal-multiple-loops.c",
    "test/test-signal-pending-on-close.c",
    "test/test-sizeof.c",
    "test/test-socket-buffer-size.c",
    "test/test-spawn.c",
    "test/test-stdio-over-pipes.c",
    "test/test-strscpy.c",
    "test/test-strtok.c",
    "test/test-tcp-alloc-cb-fail.c",
    "test/test-tcp-bind6-error.c",
    "test/test-tcp-bind-error.c",
    "test/test-tcp-close-accept.c",
    "test/test-tcp-close-after-read-timeout.c",
    "test/test-tcp-close.c",
    "test/test-tcp-close-reset.c",
    "test/test-tcp-close-while-connecting.c",
    "test/test-tcp-connect6-error.c",
    "test/test-tcp-connect-error-after-write.c",
    "test/test-tcp-connect-error.c",
    "test/test-tcp-connect-timeout.c",
    "test/test-tcp-create-socket-early.c",
    "test/test-tcp-flags.c",
    "test/test-tcp-oob.c",
    "test/test-tcp-open.c",
    "test/test-tcp-read-stop.c",
    "test/test-tcp-read-stop-start.c",
    "test/test-tcp-reuseport.c",
    "test/test-tcp-rst.c",
    "test/test-tcp-shutdown-after-write.c",
    "test/test-tcp-try-write.c",
    "test/test-tcp-try-write-error.c",
    "test/test-tcp-unexpected-read.c",
    "test/test-tcp-write-after-connect.c",
    "test/test-tcp-writealot.c",
    "test/test-tcp-write-fail.c",
    "test/test-tcp-write-in-a-row.c",
    "test/test-tcp-write-in-read-cb-backend-timeout.c",
    "test/test-tcp-write-queue-order.c",
    "test/test-tcp-write-to-half-open-connection.c",
    "test/test-test-macros.c",
    "test/test-thread-affinity.c",
    "test/test-thread.c",
    "test/test-thread-equal.c",
    "test/test-thread-name.c",
    "test/test-threadpool.c",
    "test/test-threadpool-cancel.c",
    "test/test-thread-priority.c",
    "test/test-timer-again.c",
    "test/test-timer.c",
    "test/test-timer-from-check.c",
    "test/test-tmpdir.c",
    "test/test-tty.c",
    "test/test-tty-duplicate-key.c",
    "test/test-tty-escape-sequence-processing.c",
    "test/test-udp-alloc-cb-fail.c",
    "test/test-udp-bind.c",
    "test/test-udp-connect6.c",
    "test/test-udp-connect.c",
    "test/test-udp-create-socket-early.c",
    "test/test-udp-dgram-too-big.c",
    "test/test-udp-ipv6.c",
    "test/test-udp-mmsg.c",
    "test/test-udp-multicast-interface6.c",
    "test/test-udp-multicast-interface.c",
    "test/test-udp-multicast-join6.c",
    "test/test-udp-multicast-join.c",
    "test/test-udp-multicast-ttl.c",
    "test/test-udp-open.c",
    "test/test-udp-options.c",
    "test/test-udp-recv-cb-close-pollerr.c",
    "test/test-udp-recv-in-a-row.c",
    "test/test-udp-recvmsg-unreachable-error.c",
    "test/test-udp-reuseport.c",
    "test/test-udp-send-and-recv.c",
    "test/test-udp-send-fail.c",
    "test/test-udp-send-hang-loop.c",
    "test/test-udp-send-immediate.c",
    "test/test-udp-sendmmsg-error.c",
    "test/test-udp-send-unreachable.c",
    "test/test-udp-try-send.c",
    "test/test-uname.c",
    "test/test-walk-handles.c",
    "test/test-watcher-cross-stop.c",
    "test/test-write-cancel.c",
]

shims.http_archive(
    name = "src",
    sha256 = "279f3f67a24bb9921fe999ca6cd5e332fade8d515873ef9ba054b70e70a31d9e",
    strip_prefix = "libuv-{}".format(VERSION),
    sub_targets = sorted(
        ["include/" + h for h in PUBLIC_HEADERS] +
        ["src/" + h for h in PRIVATE_HEADERS] +
        COMMON_SRCS + LINUX_SRCS + MACOS_SRCS +
        TEST_SRCS + ["test/fixtures"],
    ),
    type = "tar.gz",
    urls = [
        "https://github.com/libuv/libuv/archive/refs/tags/v{}.tar.gz".format(VERSION),
    ],
)

UV_DEFINES = [
    "-D_FILE_OFFSET_BITS=64",
    "-D_LARGEFILE_SOURCE",
] + shims.select({
    "config//os:linux": [
        "-D_GNU_SOURCE",
        "-D_POSIX_C_SOURCE=200112",
    ],
    "config//os:macos": [
        "-D_DARWIN_UNLIMITED_SELECT=1",
        "-D_DARWIN_USE_64_BIT_INODE=1",
    ],
})

UV_CFLAGS = [
    "-std=gnu11",
    "-fno-strict-aliasing",
    "-fvisibility=hidden",
]

shims.cxx_library(
    name = "libuv",
    srcs = [":src[{}]".format(f) for f in COMMON_SRCS] + shims.select({
        "config//os:linux": [":src[{}]".format(f) for f in LINUX_SRCS],
        "config//os:macos": [":src[{}]".format(f) for f in MACOS_SRCS],
    }),
    compiler_flags = UV_CFLAGS,
    exported_headers = {
        h: ":src[include/{}]".format(h)
        for h in PUBLIC_HEADERS
    },
    exported_linker_flags = shims.select({
        "config//os:linux": [
            "-pthread",
            "-ldl",
            "-lrt",
            "-lm",
        ],
        "config//os:macos": [
            "-pthread",
            "-lm",
        ],
    }),
    header_namespace = "",
    headers = {
        h: ":src[src/{}]".format(h)
        for h in PRIVATE_HEADERS
    } | {
        h.removeprefix("unix/"): ":src[src/{}]".format(h)
        for h in PRIVATE_HEADERS
        if h.startswith("unix/")
    },
    preferred_linkage = "static",
    preprocessor_flags = UV_DEFINES,
    visibility = ["PUBLIC"],
)

# MARK: Tests

shims.cxx_binary(
    name = "test-smoke-bin",
    srcs = ["test.c"],
    preprocessor_flags = [
        "-DEXPECTED_VERSION=\"{}\"".format(VERSION),
    ],
    deps = [":libuv"],
)

shims.command_test(
    name = "test-smoke",
    cmd = ["$(exe :test-smoke-bin)"],
)

# uv_run_tests_a: upstream's test runner, linked against the static library.
# Run with no arguments it runs every test, each in a child process; given a
# test name, it runs that test alone. Helpers re-execute argv[0].
#
# The tests include internal sources by paths relative to test/, like
# "../src/idna.c", so they compile against the whole unpacked tree.
shims.cxx_binary(
    name = "run-tests",
    srcs = [":src[{}]".format(f) for f in TEST_SRCS],
    compiler_flags = UV_CFLAGS,
    linker_flags = ["-lutil"],
    preprocessor_flags = UV_DEFINES + ["-I$(location :src)/test"],
    deps = [":libuv"],
)

# Tests whose verdict depends on the network outside this machine. Each one
# skips itself where the network is unreachable, but where it is reachable
# the result depends on how far-off hosts, firewalls, resolvers or the
# machine's own routes answer.
UPSTREAM_TESTS_EXCLUDED = [
    # Resolve a name that does not exist, through the system's resolvers.
    "getaddrinfo_fail",
    "getaddrinfo_fail_sync",
    # Connect to 1.2.3.4 and 8.8.8.8, expecting no answer.
    "tcp_close_while_connecting",
    "tcp_connect_timeout",
    # Send to 192.0.2.3 (TEST-NET-1).
    "udp_send_hang_loop",
    # Connect to fe80::bad:babe through the first interface with a link-local
    # address, expecting connect() to start rather than fail; on GitHub's
    # macOS runners it fails at once with EHOSTUNREACH.
    "tcp_connect6_link_local",
    # Need a multicast route.
    "udp_multicast_interface",
    "udp_multicast_interface6",
    "udp_multicast_join",
    "udp_multicast_join6",
    "udp_multicast_ttl",
]

# Every other test the runner lists, one after another as upstream's own
# `uv_test_a` runs them: the TCP and UDP tests share fixed ports (9123-9125),
# so they cannot run alongside each other. Tests open fixtures and create
# files and sockets relative to the working directory, which is a scratch
# copy of test/. The runner's per-test watchdog is multiplied, so a loaded
# machine doesn't turn a slow test into a timeout.
#
# The runner collects each child's output in a tmpfile(), which glibc always
# creates in /tmp, so this needs a writable /tmp and fails under
# @mode//sandbox.
shims.command_test(
    name = "upstream-tests",
    script = """
        work=`mktemp -d`
        trap 'rm -rf "$work"' EXIT
        mkdir "$work/test"
        cp -R $(location :src[test/fixtures]) "$work/test/fixtures"
        chmod -R u+w "$work"
        cd "$work"
        export UV_TEST_TIMEOUT_MULTIPLIER=3
        runner=$(exe :run-tests)
        "$runner" --list | awk '{ print $1 }' | grep -Fvx """ + " ".join(["-e " + t for t in UPSTREAM_TESTS_EXCLUDED]) + """ > tests
        total=0 failed=0 skipped=0 failures=
        for t in `cat tests`; do
            total=`expr $total + 1`
            # The runner exits 0 for a pass and 7 for a skip.
            status=0
            "$runner" "$t" < /dev/null > out 2>&1 || status=$?
            cat out
            case $status in
                0) ;;
                7) skipped=`expr $skipped + 1` ;;
                *) failed=`expr $failed + 1`; failures="$failures $t" ;;
            esac
        done
        echo "libuv: $total tests, $failed failed, $skipped skipped" >&2
        if [ "$total" -lt 400 ]; then
            echo "expected at least 400 tests from the runner" >&2
            exit 1
        fi
        if [ "$failed" -ne 0 ]; then
            echo "failed:$failures" >&2
            exit 1
        fi
    """,
)
