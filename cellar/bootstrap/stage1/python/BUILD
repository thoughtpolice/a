# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "configured_tool", "generate", "generated_result_test", "installed_tool", "result_test")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary")
load(":defs.bzl", "python_object")
load(":pyconfig.bzl", "PYCONFIG_OFF", "PYCONFIG_ON", "PYCONFIG_VALUES")
load(":regen_data.bzl", "CJK_MAPPINGS", "UNICODE_DATA")
load(
    ":sources.bzl",
    "BOOTSTRAP_MODULES",
    "CONFIGURE_MODULES",
    "FROZEN_MODULES",
    "LIBEXPAT_SOURCES",
    "LIBHACL_SOURCES",
    "LIBMPDEC_SOURCES",
    "LIB_ENTRIES",
    "OBJECT_SOURCES",
    "PARSER_SOURCES",
    "PEGEN_SOURCES",
    "PYTHON_SOURCES",
    "STDLIB_MODULES",
    "TOKENIZER_SOURCES",
)

GCC = "cellar//bootstrap/stage1/gcc13"

LINUX = "cellar//bootstrap/stage1/linux-headers"

ZLIB = "cellar//bootstrap/stage1/zlib"

CC = GCC + ":stage3-gcc"

SOURCE = ":Python-3.14.7"

VERSION = "3.14"

GAWK = "cellar//bootstrap/stage1/gawk-final:gawk"

SED = "cellar//bootstrap/stage1/sed:sed"

download_file(
    name = "Python-3.14.7.tar.xz",
    hash = "3b48dac8fb59f62eaa67ac83c1eb12bda1b7a08406dd286e252c11a66be27f81",
    size_bytes = 24053924,
    urls = ["https://www.python.org/ftp/python/3.14.7/Python-3.14.7.tar.xz"],
)

C_DIRECTORIES = [
    "Include",
    "Modules",
    "Objects",
    "Parser",
    "Programs",
    "Python",
]

untar(
    name = SOURCE[1:],
    decompress = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
    files = C_DIRECTORIES + ["Lib/" + entry for entry in LIB_ENTRIES] + [
        "LICENSE",
        "Lib/test",
        "Modules/Setup.bootstrap.in",
        "Modules/Setup.stdlib.in",
        "Modules/config.c.in",
    ] + list(FROZEN_MODULES.values()),
    flags = ["-x"],
    input = ":Python-3.14.7.tar.xz",
    # The interpreter's sources, its library and test suite, and the tools
    # that regenerate its generated sources with every file they read or
    # write. No manuals, Apple, Android or WASI builds.
    only = C_DIRECTORIES + [
        "Doc/data/stable_abi.dat",
        "Doc/library/token-list.inc",
        "Doc/library/token.rst",
        "Grammar",
        "LICENSE",
        "Lib",
        "Makefile.pre.in",
        "Misc/stable_abi.toml",
        "PC",
        "PCbuild/_freeze_module.vcxproj",
        "PCbuild/_freeze_module.vcxproj.filters",
        "PCbuild/pythoncore.vcxproj",
        "Tools",
    ],
    untar = "cellar//bootstrap/stage1/pax:untar",
)

# pyconfig.h as configure writes it. The names it leaves undefined stay as
# "/* #undef */" lines, which sysconfig reads as 0.
write_file(
    name = "pyconfig.h",
    content = "".join(
        ["#define {} 1\n".format(name) for name in PYCONFIG_ON] +
        ["#define {} {}\n".format(name, value) for name, value in PYCONFIG_VALUES.items()] +
        ["/* #undef {} */\n".format(name) for name in PYCONFIG_OFF],
    ),
)

# Every module is built in, in the order of Setup.bootstrap and Setup.stdlib.
MODULES = BOOTSTRAP_MODULES | STDLIB_MODULES

# The build holds exactly the modules configure would build, and every
# Setup.stdlib module is one configure declares.
[
    fail(
        "{} is built, but configure records it as {}".format(name, state) if name in MODULES else "configure builds {}".format(name),
    )
    for name, state in CONFIGURE_MODULES.items()
    if (state == "yes") != (name in MODULES)
]

[
    fail("configure does not declare {}".format(name))
    for name in STDLIB_MODULES
    if name not in CONFIGURE_MODULES
]

export_file(name = "generators/makesetup.awk")

generate(
    name = "config.c",
    args = [
        "-v",
        "modules=" + " ".join(MODULES.keys()),
        "-f",
        "$(location :generators/makesetup.awk)",
        "$(location {}[Modules/config.c.in])".format(SOURCE),
    ],
    capture = True,
    output = "config.c",
    tool = GAWK,
)

filegroup(
    name = "source",
    srcs = {directory: "{}[{}]".format(SOURCE, directory) for directory in C_DIRECTORIES} | {
        "config.c": ":config.c",
        "pyconfig.h": ":pyconfig.h",
    },
)

# configure's choices for GCC in a release build, by the Makefile's names,
# without debugging information, which the toolchain already turns off.
BASECFLAGS = [
    "-fno-strict-overflow",
    "-Wsign-compare",
]

OPT = [
    "-DNDEBUG",
    "-O3",
    "-Wall",
]

CFLAGS_NODIST = [
    "-std=c11",
    "-Wextra",
    "-Wno-unused-parameter",
    "-Wno-missing-field-initializers",
    "-Wstrict-prototypes",
    "-Werror=implicit-function-declaration",
    "-fvisibility=hidden",
]

# The kernel's UAPI headers follow musl's, as in a native /usr/include.
CFLAGS = [
    "-idirafter",
    "$(location {}:headers)".format(LINUX),
] + BASECFLAGS + OPT + CFLAGS_NODIST

# LIBRARY_OBJS_OMIT_FROZEN without the modules: the parser, objects and
# runtime, getbuildinfo, and MODULE_OBJS, whose config.c holds the module
# table.
LIBRARY_CORE = PARSER_SOURCES + PEGEN_SOURCES + TOKENIZER_SOURCES + OBJECT_SOURCES + PYTHON_SOURCES + [
    "Modules/getbuildinfo",
    "Modules/main",
    "Modules/gcmodule",
    "Python/dynload_stub",
    "config",
]

# The strings the Makefile passes single files: configure's MACHDEP, which
# becomes sys.platform, and the ABI flags and multiarch triplet.
# getbuildinfo.c's Git revision stays empty, as in any build from a release
# tarball.
CORE_DEFINES = {
    "Python/getplatform": ['PLATFORM="linux"'],
    "Python/sysmodule": [
        'ABIFLAGS=""',
        'MULTIARCH="x86_64-linux-musl"',
    ],
}

# PY_CORE_CFLAGS builds the core and the programs.
[
    python_object(
        defines = ["Py_BUILD_CORE"] + CORE_DEFINES.get(path, []),
        # dtoa.c casts doubles through unions (bpo-30104).
        flags = CFLAGS + (["-fno-strict-aliasing"] if path == "Python/dtoa" else []),
        path = path,
        toolchain = CC,
    )
    for path in LIBRARY_CORE + [
        "Programs/python",
        "Programs/_freeze_module",
        "Modules/getpath_noop",
    ]
]

# The flags configure gives the bundled libraries and the modules built on
# them, by python_object's attribute names.
NO_FLAGS = {
    "defines": [],
    "includes": [],
    "logical_includes": [],
}

LIBMPDEC = NO_FLAGS | {
    "defines": [
        "CONFIG_64=1",
        "ASM=1",
    ],
    "logical_includes": ["Modules/_decimal/libmpdec"],
}

LIBEXPAT = NO_FLAGS | {
    "logical_includes": ["Modules/expat"],
}

LIBHACL = NO_FLAGS | {
    "defines": [
        "_BSD_SOURCE",
        "_DEFAULT_SOURCE",
    ],
    "logical_includes": [
        "Modules/_hacl",
        "Modules/_hacl/include",
    ],
}

MULTIPROCESSING = NO_FLAGS | {
    "logical_includes": ["Modules/_multiprocessing"],
}

LIBZ = NO_FLAGS | {
    "includes": [ZLIB + ":headers"],
}

MODULE_FLAGS = {module: NO_FLAGS for module in MODULES} | {
    "_decimal": LIBMPDEC,
    "pyexpat": LIBEXPAT,
    "_elementtree": LIBEXPAT,
    "_md5": LIBHACL,
    "_sha1": LIBHACL,
    "_sha2": LIBHACL,
    "_sha3": LIBHACL,
    "_blake2": LIBHACL,
    "_hmac": LIBHACL,
    "_posixshmem": MULTIPROCESSING,
    "_multiprocessing": MULTIPROCESSING,
    # binascii computes CRC-32 with zlib when configure finds it.
    "binascii": LIBZ | {"defines": ["USE_ZLIB_CRC32"]},
    "zlib": LIBZ,
}

[
    python_object(
        defines = ["Py_BUILD_CORE_BUILTIN"] + MODULE_FLAGS[module]["defines"],
        flags = CFLAGS,
        includes = MODULE_FLAGS[module]["includes"],
        logical_includes = MODULE_FLAGS[module]["logical_includes"],
        path = "Modules/" + source,
        toolchain = CC,
    )
    for module, sources in MODULES.items()
    for source in sources
]

[
    python_object(
        defines = library["defines"],
        flags = CFLAGS,
        includes = library["includes"],
        logical_includes = library["logical_includes"],
        path = path,
        toolchain = CC,
    )
    for sources, library in [
        (LIBMPDEC_SOURCES, LIBMPDEC),
        (LIBEXPAT_SOURCES, LIBEXPAT),
        (LIBHACL_SOURCES, LIBHACL),
    ]
    for path in sources
]

# LIBRARY_OBJS_OMIT_FROZEN: everything but the path configuration and the
# frozen modules, which _freeze_module is built without to make them.
LIBRARY_OBJECTS = [
    ":{}.o".format(path)
    for path in LIBRARY_CORE + [
        "Modules/" + source
        for sources in MODULES.values()
        for source in sources
    ] + LIBMPDEC_SOURCES + LIBEXPAT_SOURCES + LIBHACL_SOURCES
]

# musl gives threads 128 KiB of stack; configure has the linker ask for the
# 1 MiB Python needs, as _Py_LINKER_THREAD_STACK_SIZE records.
STACK_FLAGS = [
    "-z",
    "stack-size=1048576",
]

RUNTIME = GCC + ":stage3-link-runtime"

c_binary(
    name = "_freeze_module",
    flags = STACK_FLAGS,
    libraries = [ZLIB + ":libz.a"],
    objects = [
        ":Programs/_freeze_module.o",
        ":Modules/getpath_noop.o",
    ] + LIBRARY_OBJECTS,
    output = "_freeze_module",
    runtime = RUNTIME,
    toolchain = CC,
)

# Every module Makefile.pre.in freezes, compiled and marshalled by the C
# freezer, which also serves the ones the Makefile freezes with
# _bootstrap_python and Programs/_freeze_module.py.
[
    generate(
        name = "frozen_modules/{}.h".format(name),
        args = [
            name,
            "$(location {}[{}])".format(SOURCE, path),
        ],
        output = name + ".h",
        tool = ":_freeze_module",
    )
    for name, path in FROZEN_MODULES.items()
]

# getpath.c names its header from the build directory, frozen.c the rest from
# its own.
filegroup(
    name = "frozen-headers",
    srcs = {
        "Python/frozen_modules/{}.h".format(name): ":frozen_modules/{}.h".format(name)
        for name in FROZEN_MODULES
    },
)

# The path configuration searches from the executable for its library, as a
# relocatable installation needs; the prefixes are only a last resort.
python_object(
    defines = [
        "Py_BUILD_CORE",
        'PYTHONPATH=""',
        'PREFIX="/nonexistent-bootstrap-prefix"',
        'EXEC_PREFIX="/nonexistent-bootstrap-prefix"',
        'VERSION="{}"'.format(VERSION),
        'VPATH=""',
        'PLATLIBDIR="lib"',
        'PYTHONFRAMEWORK=""',
    ],
    flags = CFLAGS,
    includes = [":frozen-headers"],
    path = "Modules/getpath",
    toolchain = CC,
)

python_object(
    defines = ["Py_BUILD_CORE"],
    flags = CFLAGS,
    includes = [":frozen-headers[Python]"],
    path = "Python/frozen",
    toolchain = CC,
)

c_binary(
    name = "python",
    flags = STACK_FLAGS,
    libraries = [ZLIB + ":libz.a"],
    objects = [
        ":Programs/python.o",
        ":Modules/getpath.o",
        ":Python/frozen.o",
    ] + LIBRARY_OBJECTS,
    output = "python3",
    runtime = RUNTIME,
    toolchain = CC,
)

# The executable finds its prefix from the library's os.py and its exec
# prefix from lib-dynload, which holds no modules here.
write_file(
    name = "lib-dynload/README.txt",
    content = "Every extension module is built into the interpreter.\n",
)

# The Makefile's LIBDEST, within the prefix.
LIBDEST = "lib/python" + VERSION

BASE_INSTALLATION = {
    "bin/python3": ":python",
    LIBDEST + "/lib-dynload/README.txt": ":lib-dynload/README.txt",
    "share/licenses/python/LICENSE": SOURCE + "[LICENSE]",
} | {
    "{}/{}".format(LIBDEST, entry): "{}[Lib/{}]".format(SOURCE, entry)
    for entry in LIB_ENTRIES
}

filegroup(
    name = "base-installation",
    srcs = BASE_INSTALLATION,
)

installed_tool(
    name = "base-python3",
    installation = ":base-installation",
    path = "bin/python3",
)

SOABI = "cpython-{}-x86_64-linux-musl".format(VERSION.replace(".", ""))

# The Makefile variables sysconfig reports, as this build sets them, with
# configure's default time zone path, which zoneinfo reads.
SYSCONFIG_VARIABLES = {
    "ABIFLAGS": "",
    "CC": "gcc",
    "CCSHARED": "",
    "CFLAGS": " ".join(BASECFLAGS + OPT),
    "CFLAGS_NODIST": " ".join(CFLAGS_NODIST),
    "CONFIG_ARGS": "",
    "EXE": "",
    "EXT_SUFFIX": ".{}.so".format(SOABI),
    "HOST_GNU_TYPE": "x86_64-pc-linux-musl",
    "LDFLAGS": "-Wl,-z,stack-size=1048576",
    "LIBRARY": "libpython{}.a".format(VERSION),
    "MACHDEP": "linux",
    "MULTIARCH": "x86_64-linux-musl",
    "OPT": " ".join(OPT),
    "PY_CFLAGS": " ".join(BASECFLAGS + OPT),
    "PY_CFLAGS_NODIST": " ".join(CFLAGS_NODIST + [
        "-IInclude/internal",
        "-IInclude/internal/mimalloc",
    ]),
    "SHLIB_SUFFIX": ".so",
    "SOABI": SOABI,
    "TZPATH": "/usr/share/zoneinfo:/usr/lib/zoneinfo:/usr/share/lib/zoneinfo:/etc/zoneinfo",
    "VERSION": VERSION,
} | {
    "MODULE_{}_STATE".format(name.upper()): state
    for name, state in CONFIGURE_MODULES.items()
} | {
    # makesetup's lists, from Setup.stdlib before Setup.bootstrap.
    "MODBUILT_NAMES": " ".join(list(STDLIB_MODULES.keys()) + list(BOOTSTRAP_MODULES.keys())),
    "MODDISABLED_NAMES": "",
    "MODSHARED_NAMES": "",
    "MODULE_BUILDTYPE": "static",
}

export_file(name = "generators/sysconfigdata.py")

SYSCONFIGDATA = "_sysconfigdata__linux_x86_64-linux-musl.py"

generate(
    name = SYSCONFIGDATA,
    args = [
        "$(location :generators/sysconfigdata.py)",
        "$(location :pyconfig.h)",
    ] + ["{}={}".format(name, value) for name, value in SYSCONFIG_VARIABLES.items()],
    env = {"PYTHONDONTWRITEBYTECODE": "1"},
    output = SYSCONFIGDATA,
    tool = ":base-python3",
)

filegroup(
    name = "installation",
    srcs = BASE_INSTALLATION | {"{}/{}".format(LIBDEST, SYSCONFIGDATA): ":" + SYSCONFIGDATA},
)

# The interpreter as run from its installation, where it finds its library.
installed_tool(
    name = "python3-bin",
    installation = ":installation",
    path = "bin/python3",
)

# Imports write no bytecode beside the library's modules, since the
# installation is an input of whatever runs it.
configured_tool(
    name = "python3",
    env = {"PYTHONDONTWRITEBYTECODE": "1"},
    tool = ":python3-bin",
)

export_file(name = "tests/smoke.py")

generate(
    name = "smoke",
    args = ["$(location :tests/smoke.py)"],
    chdir = True,
    directory = True,
    env = {"PATH": "/nonexistent-bootstrap-path"},
    files = ["result"],
    tool = ":python3",
)

result_test(
    name = "smoke-test",
    result = ":smoke[result]",
)

# The regeneration test has the interpreter built from the shipped generated
# sources rerun the generators of make regen-all, clinic, regen-limited-abi,
# regen-stdlib-module-names, regen-unicodedata and regen-re, and the CJK
# mapping generators but the Big5-HKSCS one, and requires the regenerated
# tree to equal the shipped one. tests/levenshtein.py checks
# regen-test-levenshtein's random examples instead. Other generated files,
# such as pydoc's topics and the charmap codecs, are used as shipped.
[
    download_file(
        name = name,
        hash = data["sha256"],
        size_bytes = data["size"],
        urls = [data["url"]],
    )
    for name, data in (UNICODE_DATA | CJK_MAPPINGS).items()
]

filegroup(
    name = "unicode-data",
    srcs = {name: ":" + name for name in UNICODE_DATA},
)

filegroup(
    name = "cjk-mappings",
    srcs = {name: ":" + name for name in CJK_MAPPINGS},
)

# regen-stdlib-module-names reads the Setup files, which configure writes
# from their templates, commenting out the modules it does not build.
# MODULE_BUILDTYPE=static builds the rest in.
[
    generate(
        name = "Setup." + kind,
        args = [
            "-e",
            "s/@MODULE_BUILDTYPE@/static/",
        ] + [
            arg
            for name, state in CONFIGURE_MODULES.items()
            for arg in [
                "-e",
                "s/@MODULE_{}_TRUE@/{}/".format(
                    name.upper(),
                    "" if state == "yes" else "#",
                ),
            ]
        ] + ["$(location {}[Modules/Setup.{}.in])".format(SOURCE, kind)],
        capture = True,
        output = "Setup." + kind,
        tool = SED,
    )
    for kind in [
        "bootstrap",
        "stdlib",
    ]
]

# The directory pybuilddir.txt names in a build, where the build keeps the
# sysconfig data.
BUILD_DIRECTORY = "lib.linux-x86_64-" + VERSION

filegroup(
    name = "build-directory",
    srcs = {"{}/{}".format(BUILD_DIRECTORY, SYSCONFIGDATA): ":" + SYSCONFIGDATA},
)

export_file(name = "tests/regen.sh")

export_file(name = "tests/levenshtein.py")

generate(
    name = "regenerated",
    args = [
        "--noprofile",
        "--norc",
        "$(location :tests/regen.sh)",
        "$(exe :python3-bin)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:cp)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:chmod)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:rm)",
        "$(exe cellar//bootstrap/stage1/diffutils:diff-bin)",
        "$(location {})".format(SOURCE),
        "$(location :tests/levenshtein.py)",
        "$(location :unicode-data)",
        "$(location :cjk-mappings)",
        "$(location :Setup.stdlib)",
        "$(location :Setup.bootstrap)",
        "$(location :build-directory)",
        BUILD_DIRECTORY,
    ],
    chdir = True,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    files = ["result"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

result_test(
    name = "regeneration-test",
    result = ":regenerated[result]",
)

# The regression tests of what pyconfig.h decides: the system interfaces,
# time, numbers, text, hashing, sockets, signals and threads, and of zlib and
# the archive formats built on it. They run where build actions do, which may
# be an image with no shell or other programs, so test_subprocess, which
# needs /bin/sh, cat and sleep, is left out.
REGRTESTS = [
    "test_array",
    "test_ast",
    "test_binascii",
    "test_bytes",
    "test_cmath",
    "test_codecs",
    "test_datetime",
    "test_decimal",
    "test_errno",
    "test_fcntl",
    "test_fileio",
    "test_float",
    "test_grp",
    "test_gzip",
    "test_hashlib",
    "test_hmac",
    "test_io",
    "test_json",
    "test_locale",
    "test_long",
    "test_math",
    "test_mmap",
    "test_os",
    "test_platform",
    "test_posix",
    "test_pty",
    "test_pwd",
    "test_re",
    "test_resource",
    "test_select",
    "test_selectors",
    "test_shutil",
    "test_signal",
    "test_socket",
    "test_str",
    "test_struct",
    "test_sys",
    "test_tarfile",
    "test_tempfile",
    "test_termios",
    "test_threading",
    "test_time",
    "test_unicodedata",
    "test_xml_etree",
    "test_zipfile",
    "test_zipimport",
    "test_zlib",
    "test_zoneinfo",
]

# The cases the run leaves out. CPython skips the first group on musl, but
# platform.libc_ver() finds musl only by its dynamic loader's name, which a
# static executable lacks.
REGRTEST_IGNORED = [
    "test.test_locale.TestEnUSCollation.test_strcoll_with_diacritic",
    "test.test_locale.TestEnUSCollation.test_strxfrm_with_diacritic",
    "test.test_math.FMATests.test_fma_zero_result",
    "test.test_os.TestInvalidFD.test_fpathconf_bad_fd",
    "test.test_os.TestInvalidFD.test_pathconf_negative_fd_uses_fd_semantics",
    "test.test_posix.PosixTester.test_makedev",
    "test.test_re.ReTests.test_locale_caching",
    "test.test_re.ReTests.test_locale_compiled",
    # These import _testcapi or _testinternalcapi, test modules the
    # interpreter does not build in.
    "test.test_posix.PosixTester.test_pipe2_c_limits",
    "test.test_sys.TestSysJIT.test_jit_is_active",
    "test.test_threading.ThreadTests.test_finalize_daemon_thread_hang",
    # This one runs id through /bin/sh.
    "test.test_posix.PosixTester.test_getgroups",
]

export_file(name = "tests/regrtest.sh")

# The run takes most of an hour, so it carries the `slow` label, which test
# sweeps leave out. Naming the target, or passing --no-default-test-filters,
# still runs it.
generated_result_test(
    name = "regrtest-test",
    args = [
        "--noprofile",
        "--norc",
        "$(location :tests/regrtest.sh)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:cp)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:chmod)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:rm)",
        "$(location :installation)",
        LIBDEST,
        "$(location {}[Lib/test])".format(SOURCE),
    ] + REGRTESTS + [
        "--ignore=" + case
        for case in REGRTEST_IGNORED
    ],
    chdir = True,
    directory = True,
    env = {"PATH": "/nonexistent-bootstrap-path"},
    labels = ["slow"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)
