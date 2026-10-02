# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The C library and Clang's runtimes that one compiler stage builds: musl,
# the compiler-rt builtins and startup files, libunwind, libc++abi, libc++
# and mimalloc. Each is compiled as its upstream build compiles it for static
# x86_64 Linux with musl, optimized like the LLVM stages and without warning
# flags. The literal source lists come from inventory.bzl; the choices among
# them follow the CMake conditions for this configuration.

load("@cellar//bootstrap:actions.bzl", "generate", "installed_tool")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap/stage1:defs.bzl", "c_library", "c_object", "c_toolchain", "compiler", "link_runtime")
load("@cellar//bootstrap/stage1/mimalloc:defs.bzl", "mimalloc_object")
load("@cellar//bootstrap/stage1/musl12:defs.bzl", "COMPAT_LIBRARIES", "INCLUDE_DIRECTORIES", "LIBC_SOURCES")
load("@cellar//bootstrap/stage1/musl12:sources.bzl", "CRT_SOURCES")
load(":defs.bzl", "LLVM_MAJOR", "PYTHON", "SED", "SOURCE", "sed_replacement")
load(":inventory.bzl", "RUNTIME_LISTS")

TRIPLE = "x86_64-unknown-linux-musl"

MUSL = "cellar//bootstrap/stage1/musl12"

LINUX = "cellar//bootstrap/stage1/linux-headers"

# --- Sources ---

# The runtimes' part of the tarball, extracted apart from the compiler's.
# The runtimes also read two directories of the compiler's tree that LLVM
# itself compiles with: LLVM libc's shared headers, for libc++'s float
# parsing, and SipHash, for the builtins.
RUNTIMES_SOURCE = ":runtimes-source"

RUNTIME_PROJECTS = [
    "compiler-rt",
    "libcxx",
    "libcxxabi",
    "libunwind",
]

# The runtimes' sources and installed headers, the script that maps libc++'s
# headers for include-what-you-use, and each project's notice.
RUNTIME_PATHS = [
    "compiler-rt/lib/builtins",
    "libcxx/include",
    "libcxx/src",
    "libcxx/utils/generate_iwyu_mapping.py",
    "libcxx/utils/libcxx/__init__.py",
    "libcxx/utils/libcxx/header_information.py",
    "libcxx/vendor",
    "libcxxabi/include",
    "libcxxabi/src",
    "libunwind/include",
    "libunwind/src",
] + [project + "/LICENSE.TXT" for project in RUNTIME_PROJECTS]

def _runtimes_path(path):
    return "$(location {})/{}".format(RUNTIMES_SOURCE, path)

def _compiler_path(path):
    return "$(location {})/{}".format(SOURCE, path)

def _builtins_sources():
    lists = RUNTIME_LISTS["compiler-rt/lib/builtins"]

    # Outside Fuchsia, bare metal and GPUs, with unwind.h from Clang's
    # resource directory; atomic.c is left out by default.
    generic = lists["GENERIC_SOURCES"] + [
        "emutls.c",
        "enable_execute_stack.c",
        "eprintf.c",
        "gcc_personality_v0.c",
        "clear_cache.c",
    ]
    sources = generic + lists["GENERIC_TF_SOURCES"] + [
        "cpu_model/x86.c",
        "i386/fp_mode.c",
        "x86_64/floatdidf.c",
        "x86_64/floatdisf.c",
        "x86_64/floatundidf.S",
        "x86_64/floatundisf.S",
    ] + lists["x86_80_BIT_SOURCES"] + [
        "x86_64/floatdixf.c",
        "x86_64/floatundixf.S",
    ] + lists["BF16_SOURCES"]

    # filter_builtin_sources: a file in an architecture directory replaces
    # the generic C file of the same name.
    replaced = {}
    for path in sources:
        if "/" in path:
            name = path.rsplit("/", 1)[1]
            replaced[name.removesuffix(".S") + ".c" if name.endswith(".S") else name] = True
    return ["compiler-rt/lib/builtins/" + path for path in sources if path not in replaced]

BUILTINS_SOURCES = _builtins_sources()

# AArch64's native runtime, including quad precision and CPU dispatch.
_AARCH64_BUILTINS = ["compiler-rt/lib/builtins/" + path for path in RUNTIME_LISTS["compiler-rt/lib/builtins"]["GENERIC_SOURCES"] +
                                                                    RUNTIME_LISTS["compiler-rt/lib/builtins"]["GENERIC_TF_SOURCES"] +
                                                                    RUNTIME_LISTS["compiler-rt/lib/builtins"]["BF16_SOURCES"] + [
    "emutls.c",
    "enable_execute_stack.c",
    "eprintf.c",
    "gcc_personality_v0.c",
    "clear_cache.c",
    "cpu_model/aarch64.c",
    "aarch64/fp_mode.c",
    "aarch64/emupac.cpp",
    "aarch64/sme-abi.S",
    "aarch64/sme-abi-assert.c",
    "aarch64/sme-libc-opt-memset-memchr.S",
    "aarch64/sme-libc-opt-memcpy-memmove.S",
    "aarch64/sme-libc-opt-memcpy-memmove-sve.S",
]]

_AARCH64_REPLACED = {"compiler-rt/lib/builtins/" + path.rsplit("/", 1)[1]: None for path in _AARCH64_BUILTINS if "/" in path.removeprefix("compiler-rt/lib/builtins/")}
AARCH64_BUILTINS = [path for path in _AARCH64_BUILTINS if path not in _AARCH64_REPLACED]

CRT_OBJECTS = ["crtbegin", "crtend"]

LIBUNWIND_SOURCES = ["libunwind/src/" + path for path in (
    RUNTIME_LISTS["libunwind/src"]["LIBUNWIND_CXX_SOURCES"] +
    RUNTIME_LISTS["libunwind/src"]["LIBUNWIND_C_SOURCES"] +
    RUNTIME_LISTS["libunwind/src"]["LIBUNWIND_ASM_SOURCES"]
)]

# With exceptions, threads and the new and delete operators, on Unix.
LIBCXXABI_SOURCES = ["libcxxabi/src/" + path for path in RUNTIME_LISTS["libcxxabi/src"]["LIBCXXABI_SOURCES"] + [
    "stdlib_new_delete.cpp",
    "cxa_exception.cpp",
    "cxa_personality.cpp",
    "cxa_thread_atexit.cpp",
]]

# With threads, the random device, localization and the filesystem library;
# compiler-rt supplies the 128-bit multiplication filesystem needs.
LIBCXX_SOURCES = ["libcxx/src/" + path for path in [
    path
    for path in RUNTIME_LISTS["libcxx/src"]["LIBCXX_SOURCES"]
    if path.endswith(".cpp")
] + [
    "atomic.cpp",
    "barrier.cpp",
    "condition_variable_destructor.cpp",
    "condition_variable.cpp",
    "future.cpp",
    "mutex_destructor.cpp",
    "mutex.cpp",
    "shared_mutex.cpp",
    "thread.cpp",
    "random.cpp",
    "fstream.cpp",
    "ios.cpp",
    "ios.instantiations.cpp",
    "iostream.cpp",
    "locale.cpp",
    "ostream.cpp",
    "regex.cpp",
    "strstream.cpp",
    "text_encoding.cpp",
    "filesystem/directory_entry.cpp",
    "filesystem/directory_iterator.cpp",
    "filesystem/operations.cpp",
]]

# With the time zone database, which libc++ enables on Linux.
LIBCXX_EXPERIMENTAL_SOURCES = ["libcxx/src/" + path for path in RUNTIME_LISTS["libcxx/src"]["LIBCXX_EXPERIMENTAL_SOURCES"] + [
    "experimental/chrono_exception.cpp",
    "experimental/time_zone.cpp",
    "experimental/tzdb.cpp",
    "experimental/tzdb_list.cpp",
]]

def runtime_source_files():
    """Every path the runtimes project out of their tree."""
    return sorted({path: None for path in BUILTINS_SOURCES + AARCH64_BUILTINS + ["compiler-rt/lib/builtins/aarch64/lse.S"] + LIBUNWIND_SOURCES + LIBCXXABI_SOURCES + LIBCXX_SOURCES + LIBCXX_EXPERIMENTAL_SOURCES + [
        "compiler-rt/lib/builtins/{}.c".format(name)
        for name in CRT_OBJECTS
    ] + [
        "libcxx/include/" + path
        for path in RUNTIME_LISTS["libcxx/include"]["files"]
    ] + [
        "libcxxabi/include/" + path
        for path in RUNTIME_LISTS["libcxxabi/include"]["files"]
    ] + [
        "libunwind/include/" + path
        for path in RUNTIME_LISTS["libunwind/include"]["files"]
    ] + [
        "libcxx/include/__config_site.in",
        "libcxx/include/module.modulemap.in",
        "libcxx/utils/generate_iwyu_mapping.py",
        "libcxx/vendor/llvm/default_assertion_handler.in",
    ] + [project + "/LICENSE.TXT" for project in RUNTIME_PROJECTS]}.keys())

# --- Compilers ---

REPRODUCIBLE_FLAGS = [
    "-g0",
    "-Wno-builtin-macro-redefined",
    '-D__DATE__="Jan  1 1970"',
    '-D__TIME__="00:00:00"',
    '-D__TIMESTAMP__="Thu Jan  1 00:00:00 1970"',
]

# The C library headers and the kernel's, as a native /usr/include merges
# them, in place of the host's.
C_INCLUDES = [
    "-nostdlibinc",
    "-isystem",
    "$(location {}:headers)".format(MUSL),
    "-isystem",
    "$(location {}:headers)".format(LINUX),
]

CXX_INCLUDES = [
    "-nostdinc++",
    "-isystem",
    "$(location :libcxx-headers)/{}/c++/v1".format(TRIPLE),
    "-isystem",
    "$(location :libcxx-headers)/c++/v1",
]

def clang_compilers(stage, tree, archiver, config = None, tool_cpu = None, chdir = None):
    """The compilers that build a stage: the Clang, LLD and resource headers
    in tree, with archiver as their llvm-ar.

    stage-cc compiles C against musl and the kernel headers, stage-c++ adds
    libc++, and stage-bare-cc names no headers, for musl itself.
    """
    kwargs = {"target_cpu": tool_cpu} if config else {}
    c_includes = ["-nostdlibinc", "-isystem", "$(location {}:headers)".format(config.musl), "-isystem", "$(location {}:headers)".format(config.linux)] if config else C_INCLUDES
    cxx_includes = ["-nostdinc++", "-isystem", "$(location :libcxx-headers)/{}/c++/v1".format(config.triple), "-isystem", "$(location :libcxx-headers)/c++/v1"] if config else CXX_INCLUDES
    installed_tool(
        name = stage + "-driver",
        installation = tree,
        path = "bin/clang",
        **kwargs
    )
    installed_tool(
        name = stage + "-linker",
        installation = tree,
        path = "bin/ld.lld",
        **kwargs
    )
    for name, includes in {
        "bare-cc": [],
        "cc": c_includes,
        "c++": cxx_includes + c_includes,
    }.items():
        compiler_rule = c_toolchain if config else compiler
        compiler_rule(
            name = "{}-{}".format(stage, name),
            abi = config.abi if config else "x86_64-sysv",
            archive_flags = ["crsD"],
            archive_format = "ar",
            archiver = archiver,
            cflags = REPRODUCIBLE_FLAGS + (["--target=" + config.triple] if config else []) + includes,
            compiler = ":{}-driver".format(stage),
            family = "clang",
            # libunwind finds the unwind tables of a static program through
            # PT_GNU_EH_FRAME, as Clang's driver always asks LLD to write.
            ldflags = [
                "-static",
                "--eh-frame-hdr",
            ],
            linker = ":{}-linker".format(stage),
            object_format = config.object_format if config else "elf64-x86-64",
            **({"target_cpu": config.cpu, "chdir": chdir} if config else {})
        )

# --- Headers ---

def _cmake_configure(values):
    """sed arguments doing what CMake's configure_file does with values.

    A string sets a variable, True sets it to a true value and False leaves
    it unset. A template line naming a variable not in values survives as a
    #cmakedefine, which no compiler accepts.
    """
    args = []
    for name, value in values.items():
        # Names go into the patterns as they are.
        if not name.replace("_", "").isalnum():
            fail("not a CMake variable name: " + name)
        if value == False:
            expressions = [
                "s|^#cmakedefine01 {0}$|#define {0} 0|",
                "s|^#cmakedefine {0}$|/* #undef {0} */|",
                "s|^#cmakedefine {0} .*$|/* #undef {0} */|",
            ]
            text = ""
        else:
            expressions = [
                "s|^#cmakedefine01 {0}$|#define {0} 1|",
                "s|^#cmakedefine {0}$|#define {0}|",
                "s|^#cmakedefine {0} |#define {0} |",
            ]
            text = "1" if value == True else value
        for expression in expressions:
            args += ["-e", expression.format(name)]
        args += ["-e", "s|@" + name + "@|" + sed_replacement(text) + "|g"]
    return args

# libc++'s CMake configuration for static x86_64 Linux with musl: the stable
# ABI, threads through pthreads (which the headers detect themselves), every
# optional library feature, and no hardening by default.
LIBCXX_CONFIG_SITE = {
    "_LIBCPP_ABI_VERSION": "1",
    "_LIBCPP_ABI_NAMESPACE": "__1",
    "_LIBCPP_ABI_FORCE_ITANIUM": False,
    "_LIBCPP_ABI_FORCE_MICROSOFT": False,
    "_LIBCPP_HAS_THREADS": True,
    "_LIBCPP_HAS_MONOTONIC_CLOCK": True,
    "_LIBCPP_HAS_MUSL_LIBC": True,
    "_LIBCPP_HAS_THREAD_API_PTHREAD": False,
    "_LIBCPP_HAS_THREAD_API_EXTERNAL": False,
    "_LIBCPP_HAS_THREAD_API_WIN32": False,
    "_LIBCPP_HAS_THREAD_API_C11": False,
    "_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS": False,
    "_LIBCPP_HAS_VENDOR_AVAILABILITY_ANNOTATIONS": False,
    "_LIBCPP_NO_VCRUNTIME": False,
    "_LIBCPP_TYPEINFO_COMPARISON_IMPLEMENTATION": False,
    "_LIBCPP_HAS_FILESYSTEM": True,
    "_LIBCPP_HAS_RANDOM_DEVICE": True,
    "_LIBCPP_HAS_LOCALIZATION": True,
    "_LIBCPP_HAS_UNICODE": True,
    "_LIBCPP_HAS_WIDE_CHARACTERS": True,
    "_LIBCPP_HAS_TIME_ZONE_DATABASE": True,
    "_LIBCPP_INSTRUMENTED_WITH_ASAN": False,
    "_LIBCPP_PSTL_BACKEND_SERIAL": False,
    "_LIBCPP_PSTL_BACKEND_STD_THREAD": True,
    "_LIBCPP_PSTL_BACKEND_LIBDISPATCH": False,
    "_LIBCPP_HARDENING_MODE_DEFAULT": "2",
    "_LIBCPP_ASSERTION_SEMANTIC_DEFAULT": "2",
    "_LIBCPP_LIBC_PICOLIBC": False,
    "_LIBCPP_LIBC_NEWLIB": False,
    "_LIBCPP_LIBC_LLVM_LIBC": False,
    "_LIBCPP_ABI_DEFINES": False,
    "_LIBCPP_EXTRA_SITE_DEFINES": False,
}

# libunwind's own interface. Clang searches a musl sysroot's headers before
# its resource directory, whose <unwind.h> has the definitions GCC's also
# has, such as _Unwind_Ptr, so libunwind's Itanium headers stay out.
LIBUNWIND_INSTALLED_HEADERS = [
    "__libunwind_config.h",
    "libunwind.h",
]

def runtime_headers(config = None):
    triple = config.triple if config else TRIPLE
    musl = config.musl if config else MUSL
    linux = config.linux if config else LINUX
    kwargs = {"target_cpu": config.cpu} if config else {}
    """The headers libc++, libc++abi and libunwind install, and the include
    directory an installation holds."""
    generate(
        name = "libcxx-config-site",
        args = _cmake_configure(LIBCXX_CONFIG_SITE) + ["$(location {}[libcxx/include/__config_site.in])".format(RUNTIMES_SOURCE)],
        capture = True,
        output = "__config_site",
        tool = SED,
        **kwargs
    )

    # With per-target runtime directories, __config_site stays out of the
    # module map.
    generate(
        name = "libcxx-module-map",
        args = _cmake_configure({"LIBCXX_CONFIG_SITE_MODULE_ENTRY": False}) + ["$(location {}[libcxx/include/module.modulemap.in])".format(RUNTIMES_SOURCE)],
        capture = True,
        output = "module.modulemap",
        tool = SED,
        **kwargs
    )

    # libc++'s build maps its private headers to the public ones that
    # include-what-you-use should suggest. The script reads the include
    # directory beside it in the extracted tree.
    generate(
        name = "libcxx-iwyu-mapping",
        args = ["$(location {}[libcxx/utils/generate_iwyu_mapping.py])".format(RUNTIMES_SOURCE)],
        inputs = [RUNTIMES_SOURCE],
        output = "libcxx.imp",
        output_flags = ["-o"],
        tool = PYTHON,
        **kwargs
    )

    # libc++abi installs its headers beside libc++'s.
    filegroup(
        name = "libcxx-headers",
        srcs = {
            "c++/v1/" + path: "{}[libcxx/include/{}]".format(RUNTIMES_SOURCE, path)
            for path in RUNTIME_LISTS["libcxx/include"]["files"]
        } | {
            "c++/v1/" + path: "{}[libcxxabi/include/{}]".format(RUNTIMES_SOURCE, path)
            for path in RUNTIME_LISTS["libcxxabi/include"]["files"]
        } | {
            "c++/v1/__assertion_handler": RUNTIMES_SOURCE + "[libcxx/vendor/llvm/default_assertion_handler.in]",
            "c++/v1/module.modulemap": ":libcxx-module-map",
            "c++/v1/libcxx.imp": ":libcxx-iwyu-mapping",
            triple + "/c++/v1/__config_site": ":libcxx-config-site",
        },
    )

    filegroup(
        name = "libunwind-headers",
        srcs = {
            path: "{}[libunwind/include/{}]".format(RUNTIMES_SOURCE, path)
            for path in RUNTIME_LISTS["libunwind/include"]["files"]
        },
    )

    filegroup(
        name = "libunwind-installed-headers",
        srcs = {path: ":libunwind-headers[{}]".format(path) for path in LIBUNWIND_INSTALLED_HEADERS},
    )

    # An installation's include directory. musl and the kernel share
    # directories such as scsi, the kernel's files are known only once they
    # are installed, and a filegroup cannot merge trees at one path.
    if not config:
        export_file(name = "headers.sh")

    generate(
        name = "installed-headers",
        args = [
            "--noprofile",
            "--norc",
            "$(location :headers.sh)",
            "$(exe cellar//bootstrap/stage1/coreutils-final:mkdir)",
            "$(exe cellar//bootstrap/stage1/coreutils-final:cp)",
            "$(location {}:headers)".format(musl),
            "$(location {}:headers)".format(linux),
            "$(location :libcxx-headers)",
            "$(location :libunwind-installed-headers)",
        ],
        chdir = True,
        directory = True,
        env = {
            "PATH": "/nonexistent-bootstrap-path",
            "LC_ALL": "C",
        },
        tool = "cellar//bootstrap/stage1/bash:bash",
        **kwargs
    )

# --- musl, built by Clang ---

# musl's configure and Makefile with Clang: its C99 freestanding flags, -O2
# with -O3 for the string, allocation and internal code, and no unwind
# tables. Clang takes neither GCC's alignment and loop options nor, without
# -fstack-protector, needs musl's stack protector exceptions.
MUSL_FLAGS = [
    "-std=c99",
    "-nostdinc",
    "-ffreestanding",
    "-fexcess-precision=standard",
    "-frounding-math",
    "-fno-strict-aliasing",
    "-Wa,--noexecstack",
    "-O2",
    "-fno-align-functions",
    "-fomit-frame-pointer",
    "-fno-unwind-tables",
    "-fno-asynchronous-unwind-tables",
    "-ffunction-sections",
    "-fdata-sections",
    "-w",
    "-Qunused-arguments",
]

MUSL_OPTIMIZED = [
    "src/internal/",
    "src/malloc/",
    "src/string/",
]

MUSL_INCLUDES = [MUSL + ":source[" + directory + "]" for directory in INCLUDE_DIRECTORIES]

def _musl(stage, config = None):
    musl = config.musl if config else MUSL
    libc_sources = config.libc_sources if config else LIBC_SOURCES
    crt_sources = config.crt_sources if config else CRT_SOURCES
    includes = [musl + ":source[" + directory + "]" for directory in config.include_directories] if config else MUSL_INCLUDES
    kwargs = {"target_cpu": config.cpu} if config else {}
    objects = []
    for i, path in enumerate(libc_sources):
        directory = path.rsplit("/", 1)[0] + "/"
        c_object(
            name = "{}-musl-{}".format(stage, i),
            src = "{}:source[{}]".format(musl, path),
            defines = ["_XOPEN_SOURCE=700"],
            flags = MUSL_FLAGS + (["-O3"] if directory in MUSL_OPTIMIZED else []),
            headers = [musl + ":source"],
            includes = includes,
            object_name = "{}.o".format(i),
            toolchain = ":{}-bare-cc".format(stage),
            **kwargs
        )
        objects.append(":{}-musl-{}".format(stage, i))
    c_library(
        name = stage + "-libc.a",
        objects = objects,
        output = "libc.a",
        toolchain = ":{}-bare-cc".format(stage),
        **kwargs
    )
    for name in COMPAT_LIBRARIES:
        c_library(
            name = "{}-lib{}.a".format(stage, name),
            objects = [],
            output = "lib{}.a".format(name),
            toolchain = ":{}-bare-cc".format(stage),
            **kwargs
        )
    for path in crt_sources:
        name = path.rsplit("/", 1)[1].rsplit(".", 1)[0]
        c_object(
            name = "{}-{}.o".format(stage, name),
            src = "{}:source[{}]".format(musl, path),
            defines = [
                "CRT",
                "_XOPEN_SOURCE=700",
            ],
            flags = MUSL_FLAGS,
            headers = [musl + ":source"],
            includes = includes,
            object_name = name + ".o",
            toolchain = ":{}-bare-cc".format(stage),
            **kwargs
        )

# --- Runtime libraries ---

# COMPILER_RT_STANDALONE_BUILD: position-independent, hidden and without
# builtin assumptions, as the runtimes build compiles the builtins.
BUILTINS_FLAGS = [
    "-std=c11",
    "-O2",
    "-DNDEBUG",
    "-fPIC",
    "-fno-builtin",
    "-fvisibility=hidden",
    "-fomit-frame-pointer",
    "-DVISIBILITY_HIDDEN",
    "-DCOMPILER_RT_HAS_FLOAT16",
    "-isystem",
    _compiler_path("third-party/siphash/include"),
]

CRT_FLAGS = [
    "-std=c11",
    "-O2",
    "-DNDEBUG",
    "-DCRT_HAS_INITFINI_ARRAY",
    "-DEH_USE_FRAME_REGISTRY",
    "-fPIC",
]

# Upstream keeps libunwind's and libc++abi's assertions in release builds.
LIBUNWIND_FLAGS = [
    "-O2",
    "-nostdinc++",
    "-funwind-tables",
    "-D_DEBUG",
    "-D_LIBUNWIND_IS_NATIVE_ONLY",
    "-D_LIBUNWIND_HAVE_GETAUXVAL",
    "-I",
    _runtimes_path("libunwind/include"),
]

# Static libc++abi objects hide everything the headers leave unannotated,
# as upstream builds them everywhere but Windows.
LIBCXXABI_FLAGS = [
    "-std=c++23",
    "-O2",
    "-fstrict-aliasing",
    "-fsized-deallocation",
    "-fvisibility=hidden",
    "-D_DEBUG",
    "-D_LIBCXXABI_BUILDING_LIBRARY",
    "-D_LIBCPP_BUILDING_LIBRARY",
    "-D_LIBCPP_AVAILABILITY_MINIMUM_HEADER_VERSION=2",
    "-I",
    _runtimes_path("libcxxabi/include"),
    "-I",
    _runtimes_path("libcxx/src"),
    "-I",
    _runtimes_path("libunwind/include"),
]

# cxx_add_common_build_flags, with libc++abi as the ABI library.
LIBCXX_FLAGS = [
    "-std=c++26",
    "-O2",
    "-DNDEBUG",
    "-faligned-allocation",
    "-fvisibility-inlines-hidden",
    "-fvisibility=hidden",
    "-fsized-deallocation",
    "-D_LIBCPP_BUILDING_LIBRARY",
    "-D_LIBCPP_AVAILABILITY_MINIMUM_HEADER_VERSION=2",
    "-D_LIBCPP_REMOVE_TRANSITIVE_INCLUDES",
]

def _library(stage, name, output, sources, toolchain, flags, trees = [RUNTIMES_SOURCE], config = None):
    """An archive of one object per source, named after it; flags maps an
    extension to the flags of its sources, and trees are the source trees
    they read."""
    objects = []
    for i, path in enumerate(sources):
        target = "{}-{}-{}".format(stage, name, i)
        c_object(
            name = target,
            src = "{}[{}]".format(RUNTIMES_SOURCE, path),
            flags = flags[path.rsplit(".", 1)[1]],
            headers = trees,
            object_name = path.rsplit("/", 1)[1].rsplit(".", 1)[0] + ".o",
            toolchain = toolchain,
            **({"target_cpu": config.cpu} if config else {})
        )
        objects.append(":" + target)
    if output:
        c_library(
            name = "{}-{}".format(stage, output),
            objects = objects,
            output = output,
            toolchain = toolchain,
            **({"target_cpu": config.cpu} if config else {})
        )
    return objects

def llvm_runtimes(stage, config = None):
    """The C library and runtimes the stage's compilers build.

    stage-libc.a and musl's startup files, stage-libclang_rt.builtins.a,
    stage-clang_rt.crtbegin.o and crtend.o, stage-libunwind.a,
    stage-libc++abi.a, stage-libc++.a, which also holds libc++abi as
    LIBCXX_ENABLE_STATIC_ABI_LIBRARY arranges, stage-libc++experimental.a
    and stage-mimalloc.o. stage-link-runtime links a static program against
    them.
    """
    kwargs = {"target_cpu": config.cpu} if config else {}
    cc = ":{}-cc".format(stage)
    cxx = ":{}-c++".format(stage)
    _musl(stage, config)
    builtin_flags = BUILTINS_FLAGS + (["-DCOMPILER_RT_AARCH64_FMV_USES_GLOBAL_CONSTRUCTOR=1"] if config else [])
    builtins = _library(stage, "builtins", None if config else "libclang_rt.builtins.a", AARCH64_BUILTINS if config else BUILTINS_SOURCES, cc, {
        "c": builtin_flags,
        "S": builtin_flags,
        "cpp": builtin_flags + ["-std=c++17", "-fno-exceptions", "-fno-rtti"],
    }, trees = [RUNTIMES_SOURCE, SOURCE], config = config)
    if config:
        for op in ["cas", "swp", "ldadd", "ldclr", "ldeor", "ldset"]:
            for size in ([1, 2, 4, 8, 16] if op == "cas" else [1, 2, 4, 8]):
                for model in [1, 2, 3, 4, 5]:
                    name = "{}-outline-{}{}-{}".format(stage, op, size, model)
                    c_object(
                        name = name,
                        src = RUNTIMES_SOURCE + "[compiler-rt/lib/builtins/aarch64/lse.S]",
                        flags = builtin_flags + ["-I", _runtimes_path("compiler-rt/lib/builtins")],
                        defines = ["L_" + op, "SIZE=" + str(size), "MODEL=" + str(model)],
                        object_name = name.removeprefix(stage + "-") + ".o",
                        toolchain = cc,
                        **kwargs
                    )
                    builtins.append(":" + name)
        c_library(name = stage + "-libclang_rt.builtins.a", output = "libclang_rt.builtins.a", objects = builtins, toolchain = cc, **kwargs)
    for name in CRT_OBJECTS:
        c_object(
            name = "{}-clang_rt.{}.o".format(stage, name),
            src = "{}[compiler-rt/lib/builtins/{}.c]".format(RUNTIMES_SOURCE, name),
            flags = CRT_FLAGS,
            object_name = "clang_rt.{}.o".format(name),
            toolchain = cc,
            **kwargs
        )
    _library(stage, "libunwind", "libunwind.a", LIBUNWIND_SOURCES, cc, {
        "c": LIBUNWIND_FLAGS + [
            "-std=c99",
            "-fexceptions",
        ],
        "cpp": LIBUNWIND_FLAGS + [
            "-std=c++17",
            "-fstrict-aliasing",
            "-fno-exceptions",
            "-fno-rtti",
        ],
        "S": LIBUNWIND_FLAGS,
    }, config = config)
    abi = _library(stage, "libcxxabi", "libc++abi.a", LIBCXXABI_SOURCES, cxx, {"cpp": LIBCXXABI_FLAGS}, config = config)
    cxx_objects = _library(stage, "libcxx", None, LIBCXX_SOURCES, cxx, {"cpp": LIBCXX_FLAGS + [
        "-DLIBCXX_BUILDING_LIBCXXABI",
        "-DLIBC_NAMESPACE=__llvm_libc_common_utils",
        "-I",
        _runtimes_path("libcxx/src"),
        "-I",
        _runtimes_path("libcxxabi/include"),
        "-isystem",
        _compiler_path("libc"),
    ]}, trees = [RUNTIMES_SOURCE, SOURCE], config = config)
    c_library(
        name = stage + "-libc++.a",
        objects = cxx_objects + abi,
        output = "libc++.a",
        toolchain = cxx,
        **kwargs
    )
    _library(stage, "libcxx-experimental", "libc++experimental.a", LIBCXX_EXPERIMENTAL_SOURCES, cxx, {"cpp": LIBCXX_FLAGS + [
        "-D_LIBCPP_ENABLE_EXPERIMENTAL",
    ]}, config = config)

    mimalloc_object(
        name = stage + "-mimalloc.o",
        toolchain = cc,
        **({"source": config.mimalloc, "target_cpu": config.cpu} if config else {})
    )

    link_runtime(
        name = stage + "-link-runtime",
        end_objects = [
            ":{}-clang_rt.crtend.o".format(stage),
            ":{}-crtn.o".format(stage),
        ],
        libraries = [
            ":{}-libc++.a".format(stage),
            ":{}-libunwind.a".format(stage),
            ":{}-libc.a".format(stage),
            ":{}-libclang_rt.builtins.a".format(stage),
            ":{}-libc.a".format(stage),
        ],
        start_objects = [
            ":{}-crt1.o".format(stage),
            ":{}-crti.o".format(stage),
            ":{}-clang_rt.crtbegin.o".format(stage),
        ],
        **kwargs
    )

# --- Installation ---

def runtime_installation(stage, config = None):
    """Where a stage's C library, headers and runtimes lie in an installation
    that is its own sysroot, as Clang's driver looks for them."""
    triple = config.triple if config else TRIPLE
    resource = "lib/clang/{}/lib/{}/".format(LLVM_MAJOR, triple)
    files = {
        resource + "libclang_rt.builtins.a": ":{}-libclang_rt.builtins.a".format(stage),
        resource + "clang_rt.crtbegin.o": ":{}-clang_rt.crtbegin.o".format(stage),
        resource + "clang_rt.crtend.o": ":{}-clang_rt.crtend.o".format(stage),
        "include": ":installed-headers",
        "lib/libc.a": ":{}-libc.a".format(stage),
    }
    for library in [
        "libc++.a",
        "libc++abi.a",
        "libc++experimental.a",
        "libunwind.a",
    ]:
        files["lib/{}/{}".format(triple, library)] = ":{}-{}".format(stage, library)
    for name in COMPAT_LIBRARIES:
        files["lib/lib{}.a".format(name)] = ":{}-lib{}.a".format(stage, name)
    for name in [
        "crt1",
        "crti",
        "crtn",
    ]:
        files["lib/{}.o".format(name)] = ":{}-{}.o".format(stage, name)
    return files
