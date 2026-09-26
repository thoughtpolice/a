# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:host.bzl", "host_python_binary")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object", "compiler")
load(":defs.bzl", "CAPTURE", "SOURCE", "llvm_files", "llvm_stage", "resource_headers", "source_files", "target_name")
load(":inventory.bzl", "BINARIES", "ROOTS")
load(":runtimes.bzl", "clang_compilers", "llvm_runtimes", "runtime_headers", "runtime_installation", "runtime_link", "runtime_source_files")

GCC = "cellar//bootstrap/stage1/gcc13"

LIBSTDCXX = "cellar//bootstrap/stage1/libstdcxx13"

BINUTILS = "cellar//bootstrap/stage1/binutils241"

MUSL = "cellar//bootstrap/stage1/musl12"

LINUX = "cellar//bootstrap/stage1/linux-headers"

CHDIRENV = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv"

LLVM_PROJECTS = [
    "clang",
    "cmake",
    "libc",
    "libunwind",
    "lld",
    "llvm",
    "third-party",
    "utils/bazel",
]

# The projects whose code the toolchain installs, each with its own notice.
LICENSED_PROJECTS = [
    "clang",
    "compiler-rt",
    "libc",
    "libcxx",
    "libcxxabi",
    "libunwind",
    "lld",
    "llvm",
]

LICENSES = ["{}/LICENSE.TXT".format(project) for project in LICENSED_PROJECTS]

# The runtimes' sources and installed headers.
RUNTIME_PATHS = [
    "compiler-rt/lib/builtins",
    "libcxx/include",
    "libcxx/src",
    "libcxx/vendor",
    "libcxxabi/include",
    "libcxxabi/src",
]

download_file(
    name = "llvm-project-23.1.0.src.tar.xz",
    hash = "ab1f0e3ec52448c33e8782eaf0422504b87c7b016b22514653ee0d8fcee479ff",
    size_bytes = 179140728,
    urls = ["https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.0/llvm-project-23.1.0.src.tar.xz"],
)

untar(
    name = SOURCE[1:],
    chdirenv = CHDIRENV,
    decompress = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
    files = source_files() + runtime_source_files() + LICENSES,
    flags = ["-x"],
    input = ":llvm-project-23.1.0.src.tar.xz",
    # The projects built here and the overlay describing them, without their
    # test suites and manuals, and the notices of the projects only partly
    # extracted: about a seventh of the tarball.
    only = LLVM_PROJECTS + RUNTIME_PATHS + [path for path in LICENSES if path.split("/")[0] not in LLVM_PROJECTS],
    skip = [
        project + "/" + directory
        for project in LLVM_PROJECTS
        for directory in [
            "docs",
            "test",
            "unittests",
        ]
    ],
    untar = "cellar//bootstrap/stage1/pax:untar",
)

# The final GCC 13 stage and its C++ library build the first LLVM stage.
REPRODUCIBLE_FLAGS = [
    "-frandom-seed=bootstrap",
    "-g0",
    "-Wno-builtin-macro-redefined",
    '-D__DATE__="Jan  1 1970"',
    '-D__TIME__="00:00:00"',
    '-D__TIMESTAMP__="Thu Jan  1 00:00:00 1970"',
]

compiler(
    name = "gcc13-g++",
    abi = "x86_64-sysv",
    archive_flags = ["crsD"],
    archive_format = "ar",
    archiver = BINUTILS + ":ar",
    cflags = REPRODUCIBLE_FLAGS,
    compiler = LIBSTDCXX + ":stage3-g++",
    execution_runtime = MUSL + ":runtime",
    family = "gcc",
    ldflags = ["-static"],
    linker = BINUTILS + ":ld",
    object_format = "elf64-x86-64",
    stage = "gcc-13.5.0-stage3-c++",
    sysroot = GCC + ":stage3-runtime",
    target_compatible_with = [
        "cellar//bootstrap/platforms:linux",
        "cellar//bootstrap/platforms:amd64",
    ],
)

llvm_files()

# As in an LLVM release build, without assertions, exceptions or RTTI. The
# overlay's triples name glibc; this LLVM runs on and defaults to musl.
LLVM_DEFINES = {
    name: '{}="x86_64-unknown-linux-musl"'.format(name)
    for name in [
        "LLVM_HOST_TRIPLE",
        "LLVM_DEFAULT_TARGET_TRIPLE",
    ]
}

LLVM_FLAGS = {
    "c": [
        "-std=gnu11",
        "-O2",
        "-DNDEBUG",
    ],
    "c++": [
        "-std=c++17",
        "-O2",
        "-DNDEBUG",
        "-fno-exceptions",
        "-fno-rtti",
    ],
}

# musl's default 128 KiB thread stack is too small for LLVM's recursive
# passes. Its threads take the size from PT_GNU_STACK.
STACK_FLAGS = [
    "-z",
    "stack-size=8388608",
]

llvm_stage(
    defines = LLVM_DEFINES,
    flags = LLVM_FLAGS,
    link = {
        "end_objects": [
            GCC + ":stage3-crtend.o",
            MUSL + ":crtn.o",
        ],
        "flags": STACK_FLAGS,
        "libraries": [
            LIBSTDCXX + ":stage3-libstdc++.a",
            MUSL + ":libc.a",
            GCC + ":stage3-libgcc.a",
            MUSL + ":libc.a",
        ],
        # mimalloc replaces musl's malloc, as for GCC 13's compilers.
        "objects": [
            MUSL + ":crt1.o",
            MUSL + ":crti.o",
            GCC + ":stage3-crtbeginT.o",
            "cellar//bootstrap/stage1/mimalloc:mimalloc.o",
        ],
    },
    stage = "gcc",
    toolchains = {
        "c": GCC + ":stage3-gcc",
        "c++": ":gcc13-g++",
    },
)

export_file(name = "tests/tblgen.sh")

generate(
    name = "gcc-tblgen-result",
    args = [
        "--noprofile",
        "--norc",
        "$(location :tests/tblgen.sh)",
        "$(exe :gcc-llvm-llvm-min-tblgen)",
        "$(exe :gcc-llvm-llvm-tblgen)",
        "$(location {})".format(SOURCE),
        "$(location :gcc-tblgen-llvm-vt_gen-0[GenVT.inc])",
    ],
    chdir = CHDIRENV,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    files = ["passed"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

# Clang finds LLD and its resource headers beside itself.
filegroup(
    name = "gcc-toolchain",
    srcs = {
        "bin/clang": ":gcc-clang-clang",
        "bin/ld.lld": ":gcc-lld-lld",
    } | resource_headers("gcc"),
)

filegroup(
    name = "gcc13-runtime",
    srcs = {
        "crt1.o": MUSL + ":crt1.o",
        "crti.o": MUSL + ":crti.o",
        "crtn.o": MUSL + ":crtn.o",
        "libc.a": MUSL + ":libc.a",
        "crtbeginT.o": GCC + ":stage3-crtbeginT.o",
        "crtend.o": GCC + ":stage3-crtend.o",
        "libgcc.a": GCC + ":stage3-libgcc.a",
        "libstdc++.a": LIBSTDCXX + ":stage3-libstdc++.a",
    },
)

export_file(name = "tests/clang.sh")

generate(
    name = "gcc-clang-result",
    args = [
        "--noprofile",
        "--norc",
        "$(location :tests/clang.sh)",
        "$(location :gcc-toolchain)",
        "$(location {}:headers)".format(MUSL),
        "$(location {}:headers)".format(LIBSTDCXX),
        "$(location :gcc13-runtime)",
        "$(location cellar//bootstrap/stage1:acceptance-source)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:od)",
    ],
    chdir = CHDIRENV,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    files = ["passed"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

write_file(
    name = "passed",
    content = "passed\n",
)

command_test(
    name = "gcc-clang",
    args = [
        "$(location :gcc-clang-result[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

command_test(
    name = "gcc-tblgen",
    args = [
        "$(location :gcc-tblgen-result[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

# Each later stage is compiled, archived and linked by the previous stage's
# Clang, llvm-ar and LLD, against the C library and runtimes that Clang builds.
runtime_headers()

STAGES = {
    "stage2": "gcc",
    "stage3": "stage2",
}

[
    [
        clang_compilers(
            archiver = ":{}-llvm-llvm-ar".format(previous),
            stage = stage,
            tree = ":{}-toolchain".format(previous),
        ),
        llvm_runtimes(stage),
        llvm_stage(
            defines = LLVM_DEFINES,
            flags = LLVM_FLAGS,
            link = runtime_link(stage) | {
                "flags": STACK_FLAGS,
                "objects": runtime_link(stage)["objects"] + [":{}-mimalloc.o".format(stage)],
            },
            stage = stage,
            toolchains = {
                "c": ":{}-cc".format(stage),
                "c++": ":{}-c++".format(stage),
            },
        ),
    ]
    for stage, previous in STAGES.items()
]

# The tree a later stage's compilers run from. The installation lays out
# the last stage itself.
[filegroup(
    name = stage + "-toolchain",
    srcs = {
        "bin/clang": ":{}-clang-clang".format(stage),
        "bin/ld.lld": ":{}-lld-lld".format(stage),
    } | resource_headers(stage),
) for stage in STAGES.values() if stage in STAGES]

# stage2's Clang compiles as the GCC-built one does, so stage3 reproduces
# stage2 byte for byte: every program in the inventory, and every runtime
# the installation takes from stage3, with mimalloc, which the programs
# link.
COMPARED = [target_name(name) for name in BINARIES] + sorted({
    label.removeprefix(":stage3-"): None
    for label in runtime_installation("stage3").values()
    if label.startswith(":stage3-")
}.keys()) + ["mimalloc.o"]

[command_test(
    name = "compare-" + name,
    args = [
        "$(location :stage2-{})".format(name),
        "$(location :stage3-{})".format(name),
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
) for name in COMPARED]

export_file(name = "tests/runtimes.cc")

RUNTIME_TESTS = {
    "native-c": {
        "expected": "native C 4294967325\n",
        "sources": {
            "native.c": "cellar//bootstrap/stage1:acceptance-source[native.c]",
            "helper.c": "cellar//bootstrap/stage1:acceptance-source[helper.c]",
        },
    },
    "native-cxx": {
        "expected": "native C++ 4294967299\n",
        "sources": {
            "native.cc": "cellar//bootstrap/stage1:acceptance-source[native.cc]",
            "helper.c": "cellar//bootstrap/stage1:acceptance-source[helper.c]",
        },
    },
    "runtimes": {
        "expected": "runtimes a/c 555555555 1.5e+300\n",
        "sources": {"runtimes.cc": ":tests/runtimes.cc"},
    },
}

[
    [
        [c_object(
            name = "{}-{}-{}".format(stage, test, source),
            src = src,
            flags = [
                "-O2",
                "-pthread",
            ] + (["-std=c++23"] if source.endswith(".cc") else []),
            object_name = source.rsplit(".", 1)[0] + ".o",
            toolchain = ":{}-{}".format(
                stage,
                "c++" if source.endswith(".cc") else "cc",
            ),
        ) for source, src in spec["sources"].items()],
        c_binary(
            name = "{}-{}".format(stage, test),
            end_objects = runtime_link(stage)["end_objects"],
            libraries = runtime_link(stage)["libraries"],
            objects = runtime_link(stage)["objects"] + [":{}-{}-{}".format(stage, test, source) for source in spec["sources"]],
            output = test,
            toolchain = ":{}-c++".format(stage),
        ),
        generate(
            name = "{}-{}-output".format(stage, test),
            capture = CAPTURE,
            tool = ":{}-{}".format(stage, test),
        ),
        write_file(
            name = "{}-{}-expected".format(stage, test),
            content = spec["expected"],
        ),
        command_test(
            name = "{}-{}-test".format(stage, test),
            args = [
                "$(location :{}-{}-output)".format(stage, test),
                "$(location :{}-{}-expected)".format(stage, test),
            ],
            tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
        ),
    ]
    for stage in STAGES
    for test, spec in RUNTIME_TESTS.items()
]

# clang++ and llvm-ranlib run clang and llvm-ar under their own names, as
# links to them would, since Buck keeps no links inside an installation.
ALIASES = {
    "clang++": "clang",
    "llvm-ranlib": "llvm-ar",
}

export_file(name = "alias.c")

[
    [
        c_object(
            name = "stage3-{}-alias.o".format(alias),
            src = ":alias.c",
            defines = ['TARGET="{}"'.format(target)],
            flags = [
                "-std=c11",
                "-O2",
            ],
            object_name = "alias.o",
            toolchain = ":stage3-cc",
        ),
        c_binary(
            name = "stage3-{}-alias".format(alias),
            end_objects = runtime_link("stage3")["end_objects"],
            libraries = runtime_link("stage3")["libraries"],
            objects = runtime_link("stage3")["objects"] + [":stage3-{}-alias.o".format(alias)],
            output = alias,
            toolchain = ":stage3-cc",
        ),
    ]
    for alias, target in ALIASES.items()
]

# The final toolchain: stage3 with its runtimes, in an installation that is
# its own sysroot. The configuration file beside Clang selects them.
write_file(
    name = "x86_64-unknown-linux-musl.cfg",
    content = "\n".join([
        "--sysroot=<CFGDIR>/..",
        "-rtlib=compiler-rt",
        "-unwindlib=libunwind",
        "-stdlib=libc++",
        "-fuse-ld=lld",
        "-static",
    ]) + "\n",
)

filegroup(
    name = "toolchain",
    srcs = {
        "bin/clang": ":stage3-clang-clang",
        "bin/ld.lld": ":stage3-lld-lld",
        "bin/llvm-ar": ":stage3-llvm-llvm-ar",
        "bin/x86_64-unknown-linux-musl.cfg": ":x86_64-unknown-linux-musl.cfg",
        "share/licenses/linux": LINUX + ":installation[share/licenses/linux]",
        "share/licenses/mimalloc/LICENSE": "cellar//bootstrap/stage1/mimalloc:mimalloc-3.5.3[LICENSE]",
        "share/licenses/musl/COPYRIGHT": MUSL + ":source[COPYRIGHT]",
    } | {
        "share/licenses/" + path: "{}[{}]".format(SOURCE, path)
        for path in LICENSES
    } | {
        "bin/" + alias: ":stage3-{}-alias".format(alias)
        for alias in ALIASES
    } | resource_headers("stage3") | runtime_installation("stage3"),
)

export_file(name = "tests/toolchain.sh")

generate(
    name = "toolchain-result",
    args = [
        "--noprofile",
        "--norc",
        "$(location :tests/toolchain.sh)",
        "$(location :toolchain)",
        "$(location cellar//bootstrap/stage1:acceptance-source)",
        "$(location :tests/runtimes.cc)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:od)",
        "$(exe cellar//bootstrap/stage1/grep:grep)",
        "$(location {}:headers)".format(MUSL),
        "$(location {}:headers)".format(LINUX),
        "$(exe cellar//bootstrap/stage1/diffutils:cmp)",
    ],
    chdir = CHDIRENV,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "TMPDIR": ".",
        "LC_ALL": "C",
    },
    files = ["passed"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

command_test(
    name = "toolchain-test",
    args = [
        "$(location :toolchain-result[passed])",
        "$(location :passed)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

# The committed inventory is what inventory.py makes from this tarball.
export_file(name = "inventory.bzl")

# Rewrites inventory.bzl from the extracted tarball for the roots it names,
# and for any more given after --.
host_python_binary(
    name = "inventory",
    src = "inventory.py",
    args = [
        "$(location {})".format(SOURCE),
        "$(location :inventory.bzl)",
    ] + ROOTS,
)

export_file(name = "inventory.py")

command_test(
    name = "inventory-test",
    args = [
        "$(location :inventory.py)",
        "--check",
        "$(location {})".format(SOURCE),
        "$(location :inventory.bzl)",
    ],
    tool = "cellar//bootstrap/stage1/python:python3",
)
