# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "compare_test", "configured_tool", "generate", "result_test")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary", "c_object", "compiler")
load("@cellar//bootstrap/stage1/mimalloc:defs.bzl", "mimalloc_object")
load(":defs.bzl", "PYTHON", "SOURCE", "llvm_files", "llvm_stage", "resource_headers", "source_files", "target_name")
load(":inventory.bzl", "BINARIES", "ROOTS")
load(":runtimes.bzl", "LINUX", "MUSL", "RUNTIMES_SOURCE", "RUNTIME_PATHS", "RUNTIME_PROJECTS", "clang_compilers", "llvm_runtimes", "runtime_headers", "runtime_installation", "runtime_source_files")

GCC = "cellar//bootstrap/stage1/gcc13"

LIBSTDCXX = "cellar//bootstrap/stage1/libstdcxx13"

BINUTILS = "cellar//bootstrap/stage1/binutils241"

# The projects the compiler is built from, with the overlay describing them.
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

# The compiler projects whose code the toolchain installs, each with its own
# notice. The runtimes' tree holds the runtime projects' notices.
LICENSED_PROJECTS = [
    "clang",
    "libc",
    "lld",
    "llvm",
]

# Each later stage is compiled, archived and linked by the previous stage's
# Clang, llvm-ar and LLD, against the C library and runtimes that Clang builds.
PREDECESSOR = {
    "stage2": "gcc",
    "stage3": "stage2",
}

# --- Source ---

download_file(
    name = "llvm-project-23.1.0.src.tar.xz",
    hash = "ab1f0e3ec52448c33e8782eaf0422504b87c7b016b22514653ee0d8fcee479ff",
    size_bytes = 179140728,
    urls = ["https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.0/llvm-project-23.1.0.src.tar.xz"],
)

untar(
    name = SOURCE[1:],
    decompress = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
    directory = "llvm-project-23.1.0.src",
    files = source_files() + [project + "/LICENSE.TXT" for project in LICENSED_PROJECTS],
    flags = ["-x"],
    input = ":llvm-project-23.1.0.src.tar.xz",
    # Without the test suites and manuals.
    only = LLVM_PROJECTS,
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

# The runtimes' part of the same archive, kept apart so the compiler tree
# that every LLVM object depends on does not change with it.
untar(
    name = RUNTIMES_SOURCE[1:],
    decompress = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
    directory = "llvm-project-23.1.0.src",
    files = runtime_source_files(),
    flags = ["-x"],
    input = ":llvm-project-23.1.0.src.tar.xz",
    only = RUNTIME_PATHS,
    untar = "cellar//bootstrap/stage1/pax:untar",
)

# --- The stage GCC 13 builds ---

# The final GCC 13 stage and its C++ library compile the first LLVM stage.
# gcc13 defines this compiler as <stage>-host-g++ only for the stages that
# build another GCC, which stage3 does not.
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
    sysroot = GCC + ":stage3-runtime",
)

llvm_files()

# The overlay's triples name glibc; this LLVM runs on and defaults to musl.
LLVM_DEFINES = {
    name: '{}="x86_64-unknown-linux-musl"'.format(name)
    for name in [
        "LLVM_HOST_TRIPLE",
        "LLVM_DEFAULT_TARGET_TRIPLE",
    ]
}

# LLVM's release flags at the -O2 of Bazel's opt mode, where CMake's release
# builds use -O3: no assertions, exceptions or RTTI, and each function and
# datum in a section of its own, which the link drops if no program reaches
# it.
LLVM_FLAGS = {
    "c": [
        "-std=gnu11",
        "-O2",
        "-DNDEBUG",
        "-ffunction-sections",
        "-fdata-sections",
    ],
    "c++": [
        "-std=c++17",
        "-O2",
        "-DNDEBUG",
        "-ffunction-sections",
        "-fdata-sections",
        "-fno-exceptions",
        "-fno-rtti",
    ],
}

# --gc-sections as LLVM's CMake links its programs outside debug builds.
# musl's default 128 KiB thread stack is too small for LLVM's recursive
# passes; its threads take the size from PT_GNU_STACK.
LINK_FLAGS = [
    "--gc-sections",
    "-z",
    "stack-size=8388608",
]

# The programs link libstdc++ and GCC 13's runtime, with mimalloc in place
# of musl's malloc, as GCC 13's compilers do. Each stage's mimalloc comes
# from the compiler that builds that stage.
mimalloc_object(
    name = "gcc-mimalloc.o",
    toolchain = GCC + ":stage3-gcc",
)

llvm_stage(
    defines = LLVM_DEFINES,
    flags = LLVM_FLAGS,
    link_flags = LINK_FLAGS,
    link_libraries = [LIBSTDCXX + ":stage3-libstdc++.a"],
    link_objects = [":gcc-mimalloc.o"],
    runtime = GCC + ":stage3-link-runtime",
    stage = "gcc",
    toolchains = {
        "c": GCC + ":stage3-gcc",
        "c++": ":gcc13-g++",
    },
)

# The trees the later stages' compilers run from: Clang finds LLD and its
# resource headers beside itself. The installation lays out the last stage.
[filegroup(
    name = stage + "-toolchain",
    srcs = {
        "bin/clang": ":{}-clang-clang".format(stage),
        "bin/ld.lld": ":{}-lld-lld".format(stage),
    } | resource_headers(stage),
) for stage in PREDECESSOR.values()]

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
    chdir = True,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    files = ["passed"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

result_test(
    name = "gcc-tblgen",
    result = ":gcc-tblgen-result[passed]",
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
        "$(location {}:stage3-runtime)".format(GCC),
        "$(location {}:stage3-libstdc++.a)".format(LIBSTDCXX),
        "$(location cellar//bootstrap/stage1/installation:acceptance-source)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:od)",
    ],
    chdir = True,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    files = ["passed"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

result_test(
    name = "gcc-clang",
    result = ":gcc-clang-result[passed]",
)

# --- The stages Clang builds ---

runtime_headers()

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
            link_flags = LINK_FLAGS,
            link_objects = [":{}-mimalloc.o".format(stage)],
            runtime = ":{}-link-runtime".format(stage),
            stage = stage,
            toolchains = {
                "c": ":{}-cc".format(stage),
                "c++": ":{}-c++".format(stage),
            },
        ),
    ]
    for stage, previous in PREDECESSOR.items()
]

# stage2's Clang compiles as the GCC-built one does, so stage3 reproduces
# stage2 byte for byte: every program in the inventory, and every runtime
# the installation takes from stage3, with mimalloc, which the programs
# link.
COMPARED = [target_name(name) for name in BINARIES] + sorted({
    label.removeprefix(":stage3-"): None
    for label in runtime_installation("stage3").values()
    if label.startswith(":stage3-")
}.keys()) + ["mimalloc.o"]

[compare_test(
    name = "compare-" + name,
    actual = ":stage3-" + name,
    expected = ":stage2-" + name,
) for name in COMPARED]

export_file(name = "tests/runtimes.cc")

RUNTIME_TESTS = {
    "native-c": {
        "expected": "native C 4294967325\n",
        "sources": {
            "native.c": "cellar//bootstrap/stage1/installation:acceptance-source[native.c]",
            "helper.c": "cellar//bootstrap/stage1/installation:acceptance-source[helper.c]",
        },
    },
    "native-cxx": {
        "expected": "native C++ 4294967299\n",
        "sources": {
            "native.cc": "cellar//bootstrap/stage1/installation:acceptance-source[native.cc]",
            "helper.c": "cellar//bootstrap/stage1/installation:acceptance-source[helper.c]",
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
            objects = [":{}-{}-{}".format(stage, test, source) for source in spec["sources"]],
            output = test,
            runtime = ":{}-link-runtime".format(stage),
            toolchain = ":{}-c++".format(stage),
        ),
        generate(
            name = "{}-{}-output".format(stage, test),
            capture = True,
            tool = ":{}-{}".format(stage, test),
        ),
        write_file(
            name = "{}-{}-expected".format(stage, test),
            content = spec["expected"],
        ),
        compare_test(
            name = "{}-{}-test".format(stage, test),
            actual = ":{}-{}-output".format(stage, test),
            expected = ":{}-{}-expected".format(stage, test),
        ),
    ]
    for stage in PREDECESSOR
    for test, spec in RUNTIME_TESTS.items()
]

# --- Installation ---

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
            objects = [":stage3-{}-alias.o".format(alias)],
            output = alias,
            runtime = ":stage3-link-runtime",
            toolchain = ":stage3-cc",
        ),
    ]
    for alias, target in ALIASES.items()
]

# The installed programs are stage3's without their symbol tables, which a
# static program never reads. The compare tests check the programs as linked.
INSTALLED_PROGRAMS = {
    "clang": ":stage3-clang-clang",
    "ld.lld": ":stage3-lld-lld",
    "llvm-ar": ":stage3-llvm-llvm-ar",
}

[generate(
    name = "installed-" + program,
    args = [
        "--strip-all",
        "$(location {})".format(target),
    ],
    output = program,
    output_flags = ["-o"],
    tool = BINUTILS + ":strip",
) for program, target in INSTALLED_PROGRAMS.items()]

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
        "bin/" + program: ":installed-" + program
        for program in INSTALLED_PROGRAMS
    } | {
        "bin/" + alias: ":stage3-{}-alias".format(alias)
        for alias in ALIASES
    } | {
        "bin/x86_64-unknown-linux-musl.cfg": ":x86_64-unknown-linux-musl.cfg",
        "share/licenses/linux": LINUX + ":installation[share/licenses/linux]",
        "share/licenses/mimalloc/LICENSE": "cellar//bootstrap/stage1/mimalloc:mimalloc-3.5.3[LICENSE]",
        "share/licenses/musl/COPYRIGHT": MUSL + ":source[COPYRIGHT]",
    } | {
        "share/licenses/{}/LICENSE.TXT".format(project): "{}[{}/LICENSE.TXT]".format(SOURCE, project)
        for project in LICENSED_PROJECTS
    } | {
        "share/licenses/{}/LICENSE.TXT".format(project): "{}[{}/LICENSE.TXT]".format(RUNTIMES_SOURCE, project)
        for project in RUNTIME_PROJECTS
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
        "$(location cellar//bootstrap/stage1/installation:acceptance-source)",
        "$(location :tests/runtimes.cc)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:od)",
        "$(exe cellar//bootstrap/stage1/grep:grep)",
        "$(location {}:headers)".format(MUSL),
        "$(location {}:headers)".format(LINUX),
        "$(exe cellar//bootstrap/stage1/diffutils:cmp)",
        "$(exe {}:readelf)".format(BINUTILS),
    ],
    chdir = True,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "TMPDIR": ".",
        "LC_ALL": "C",
    },
    files = ["passed"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

result_test(
    name = "toolchain-test",
    result = ":toolchain-result[passed]",
)

# --- Inventory ---

# The committed inventory is what inventory.py makes from this tarball.
export_file(name = "inventory.bzl")

export_file(name = "inventory.py")

# Rewrites inventory.bzl from the extracted trees for the roots it names,
# and for any more given after --.
configured_tool(
    name = "inventory",
    args = [
        "$(location :inventory.py)",
        "--runtimes",
        "$(location {})".format(RUNTIMES_SOURCE),
        "$(location {})".format(SOURCE),
        "$(location :inventory.bzl)",
    ] + ROOTS,
    tool = PYTHON,
)

command_test(
    name = "inventory-test",
    args = [
        "$(location :inventory.py)",
        "--check",
        "--runtimes",
        "$(location {})".format(RUNTIMES_SOURCE),
        "$(location {})".format(SOURCE),
        "$(location :inventory.bzl)",
    ],
    tool = PYTHON,
)
