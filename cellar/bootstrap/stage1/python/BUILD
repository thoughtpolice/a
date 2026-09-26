# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "generate", "installed_tool")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "download_file", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_binary")
load(":defs.bzl", "python_object")
load(":pyconfig.bzl", "PYCONFIG_OFF", "PYCONFIG_ON", "PYCONFIG_VALUES")
load(
    ":sources.bzl",
    "BOOTSTRAP_MODULES",
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

MUSL = "cellar//bootstrap/stage1/musl12"

LINUX = "cellar//bootstrap/stage1/linux-headers"

CC = GCC + ":stage3-gcc"

SOURCE = ":Python-3.14.7"

VERSION = "3.14"

CAPTURE = "cellar//bootstrap/stage1/tools:capture"

CHDIRENV = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv"

GAWK = "cellar//bootstrap/stage1/gawk-final:gawk"

CRT = [
    MUSL + ":crt1.o",
    MUSL + ":crti.o",
    GCC + ":stage3-crtbeginT.o",
]

CRTN = [
    GCC + ":stage3-crtend.o",
    MUSL + ":crtn.o",
]

LIBC = [
    MUSL + ":libc.a",
    GCC + ":stage3-libgcc.a",
    MUSL + ":libc.a",
]

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
    chdirenv = CHDIRENV,
    decompress = "cellar//bootstrap/stage0-posix/mescc-tools-extra:unxz",
    files = C_DIRECTORIES + ["Lib/" + entry for entry in LIB_ENTRIES] + [
        "LICENSE",
        "Lib/test",
        "Modules/config.c.in",
        "Modules/getpath.py",
        "Tools/freeze/flag.py",
    ] + [path for path in FROZEN_MODULES.values() if path.startswith("Lib/") and path.removeprefix("Lib/") not in LIB_ENTRIES],
    flags = ["-x"],
    input = ":Python-3.14.7.tar.xz",
    # The interpreter's sources, its library and test suite, and the tools
    # that regenerate its generated sources with every file they read or
    # write: no manuals, Apple, Android or WASI builds.
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

write_file(
    name = "pyconfig.h",
    content = "".join(["#define {} 1\n".format(name) for name in PYCONFIG_ON]) + "".join(["#define {} {}\n".format(name, value) for name, value in PYCONFIG_VALUES.items()]) + "".join(["/* #undef {} */\n".format(name) for name in PYCONFIG_OFF]),
)

# Every module is built in, in the order of Setup.bootstrap and Setup.stdlib.
MODULES = BOOTSTRAP_MODULES | STDLIB_MODULES

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
    capture = CAPTURE,
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

# The core, which PY_CORE_CFLAGS builds.
CORE_SOURCES = PARSER_SOURCES + PEGEN_SOURCES + TOKENIZER_SOURCES + OBJECT_SOURCES + PYTHON_SOURCES + [
    "Modules/main",
    "Modules/gcmodule",
    "Python/dynload_stub",
    "Programs/python",
    "Programs/_freeze_module",
    "Modules/getpath_noop",
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

[
    python_object(
        defines = ["Py_BUILD_CORE"] + CORE_DEFINES.get(path, []),
        # dtoa.c casts doubles through unions (bpo-30104).
        flags = CFLAGS + (["-fno-strict-aliasing"] if path == "Python/dtoa" else []),
        path = path,
        toolchain = CC,
    )
    for path in CORE_SOURCES + ["Modules/getbuildinfo"]
]

python_object(
    defines = ["Py_BUILD_CORE"],
    flags = CFLAGS,
    path = "config",
    toolchain = CC,
)

# The flags configure gives the bundled libraries and the modules built on
# them.
LIBMPDEC = {
    "defines": [
        "CONFIG_64=1",
        "ASM=1",
    ],
    "includes": ["Modules/_decimal/libmpdec"],
}

LIBEXPAT = {
    "defines": [],
    "includes": ["Modules/expat"],
}

LIBHACL = {
    "defines": [
        "_BSD_SOURCE",
        "_DEFAULT_SOURCE",
    ],
    "includes": [
        "Modules/_hacl",
        "Modules/_hacl/include",
    ],
}

MULTIPROCESSING = {
    "defines": [],
    "includes": ["Modules/_multiprocessing"],
}

MODULE_FLAGS = {
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
}

[
    python_object(
        defines = ["Py_BUILD_CORE_BUILTIN"] + MODULE_FLAGS.get(module, {}).get("defines", []),
        flags = CFLAGS,
        logical_includes = MODULE_FLAGS.get(module, {}).get("includes", []),
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
        logical_includes = library["includes"],
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
LIBRARY_OBJECTS = [":{}.o".format(path) for path in PARSER_SOURCES + PEGEN_SOURCES + TOKENIZER_SOURCES + OBJECT_SOURCES + PYTHON_SOURCES + [
    "Modules/getbuildinfo",
    "Modules/main",
    "Modules/gcmodule",
    "Python/dynload_stub",
    "config",
]] + [
    ":Modules/{}.o".format(source)
    for sources in MODULES.values()
    for source in sources
] + [":{}.o".format(path) for path in LIBMPDEC_SOURCES + LIBEXPAT_SOURCES + LIBHACL_SOURCES]

# musl gives threads 128 KiB of stack; configure has the linker ask for the
# 1 MiB Python needs, as _Py_LINKER_THREAD_STACK_SIZE records.
STACK_FLAGS = [
    "-z",
    "stack-size=1048576",
]

c_binary(
    name = "_freeze_module",
    end_objects = CRTN,
    flags = STACK_FLAGS,
    libraries = LIBC,
    objects = CRT + [
        ":Programs/_freeze_module.o",
        ":Modules/getpath_noop.o",
    ] + LIBRARY_OBJECTS,
    output = "_freeze_module",
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
    srcs = {"Python/frozen_modules/{}.h".format(name): ":frozen_modules/{}.h".format(name) for name in FROZEN_MODULES},
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
    end_objects = CRTN,
    flags = STACK_FLAGS,
    libraries = LIBC,
    objects = CRT + [
        ":Programs/python.o",
        ":Modules/getpath.o",
        ":Python/frozen.o",
    ] + LIBRARY_OBJECTS,
    output = "python3",
    toolchain = CC,
)

# The executable finds its prefix from the library's os.py and its exec
# prefix from lib-dynload, which holds no modules here.
write_file(
    name = "lib-dynload/README.txt",
    content = "Every extension module is built into the interpreter.\n",
)

BASE_INSTALLATION = {
    "bin/python3": ":python",
    "lib/python{}/lib-dynload/README.txt".format(VERSION): ":lib-dynload/README.txt",
    "share/licenses/python/LICENSE": SOURCE + "[LICENSE]",
} | {
    "lib/python{}/{}".format(VERSION, entry): "{}[Lib/{}]".format(SOURCE, entry)
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
    "EXT_SUFFIX": ".cpython-314-x86_64-linux-musl.so",
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
    "SOABI": "cpython-314-x86_64-linux-musl",
    "TZPATH": "/usr/share/zoneinfo:/usr/lib/zoneinfo:/usr/share/lib/zoneinfo:/etc/zoneinfo",
    "VERSION": VERSION,
}

export_file(name = "generators/sysconfigdata.py")

SYSCONFIGDATA = "_sysconfigdata__linux_x86_64-linux-musl.py"

generate(
    name = SYSCONFIGDATA,
    args = [
        "$(location :generators/sysconfigdata.py)",
        "$(location :pyconfig.h)",
    ] + ["{}={}".format(name, value) for name, value in SYSCONFIG_VARIABLES.items()],
    output = SYSCONFIGDATA,
    tool = ":base-python3",
)

filegroup(
    name = "installation",
    srcs = BASE_INSTALLATION | {"lib/python{}/{}".format(VERSION, SYSCONFIGDATA): ":" + SYSCONFIGDATA},
)

# The interpreter as run from its installation, where it finds its library.
installed_tool(
    name = "python3",
    installation = ":installation",
    path = "bin/python3",
)

export_file(name = "tests/smoke.py")

generate(
    name = "smoke",
    args = ["$(location :tests/smoke.py)"],
    chdir = CHDIRENV,
    directory = True,
    env = {"PATH": "/nonexistent-bootstrap-path"},
    files = ["result"],
    tool = ":python3",
)

write_file(
    name = "smoke-expected",
    content = "ok\n",
)

command_test(
    name = "smoke-test",
    args = [
        "$(location :smoke[result])",
        "$(location :smoke-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

# Every generated source the tarball ships is an input above. The
# interpreter built from them regenerates each, but the Unicode database, the
# CJK mapping tables and stdlib_module_names.h, and the regenerated tree must
# equal the shipped one.
export_file(name = "tests/regen.sh")

export_file(name = "tests/levenshtein.py")

generate(
    name = "regenerated",
    args = [
        "--noprofile",
        "--norc",
        "$(location :tests/regen.sh)",
        "$(exe :python3)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:cp)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:chmod)",
        "$(exe cellar//bootstrap/stage1/coreutils-final:rm)",
        "$(exe cellar//bootstrap/stage1/diffutils:diff-bin)",
        "$(location {})".format(SOURCE),
        "$(location :tests/levenshtein.py)",
    ],
    chdir = CHDIRENV,
    directory = True,
    env = {
        "PATH": "/nonexistent-bootstrap-path",
        "LC_ALL": "C",
    },
    files = ["result"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

write_file(
    name = "regenerated-expected",
    content = "regenerated\n",
)

command_test(
    name = "regeneration-test",
    args = [
        "$(location :regenerated[result])",
        "$(location :regenerated-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)

# The regression tests of what pyconfig.h decides: the system interfaces,
# time, numbers, text, hashing, sockets, signals and threads. They run where
# build actions do, which may be an image with no shell or other programs, so
# test_subprocess, which needs /bin/sh, cat and sleep, is left out.
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
    "test_tempfile",
    "test_termios",
    "test_threading",
    "test_time",
    "test_unicodedata",
    "test_xml_etree",
    "test_zoneinfo",
]

# The installation with the test suite in the standard library, where
# tests that start isolated interpreters find it.
filegroup(
    name = "test-installation",
    srcs = BASE_INSTALLATION | {
        "lib/python{}/{}".format(VERSION, SYSCONFIGDATA): ":" + SYSCONFIGDATA,
        "lib/python{}/test".format(VERSION): SOURCE + "[Lib/test]",
    },
)

installed_tool(
    name = "test-python3",
    installation = ":test-installation",
    path = "bin/python3",
)

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

# The interpreter runs from a normalized absolute path, as it would when
# installed, in its output directory.
generate(
    name = "regrtest",
    args = [
        "--noprofile",
        "--norc",
        "-ec",
        "export HOME=\"$PWD\" TMPDIR=\"$PWD\"; python=`cd \"${1%/*}\" && pwd`/${1##*/}; \"$python\" -m test --quiet --fail-env-changed \"${@:3}\"; printf 'passed\\n' > \"$2\"",
        "regrtest",
        "$(exe :test-python3)",
        "result",
    ] + REGRTESTS + [
        "--ignore=" + case
        for case in REGRTEST_IGNORED
    ],
    chdir = CHDIRENV,
    directory = True,
    env = {"PATH": "/nonexistent-bootstrap-path"},
    files = ["result"],
    tool = "cellar//bootstrap/stage1/bash:bash",
)

write_file(
    name = "regrtest-expected",
    content = "passed\n",
)

command_test(
    name = "regrtest-test",
    args = [
        "$(location :regrtest[result])",
        "$(location :regrtest-expected)",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
)
