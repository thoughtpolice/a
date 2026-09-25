# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

# The C library and Clang's runtimes that one compiler stage builds: musl,
# the compiler-rt builtins and startup files, libunwind, libc++abi, libc++
# and mimalloc. Each is compiled as its upstream build compiles it for static
# x86_64 Linux with musl, optimized like the LLVM stages and without warning
# flags. The literal source lists come from inventory.bzl; the choices among
# them follow the CMake conditions for this configuration.

load("@cellar//bootstrap:actions.bzl", "generate", "installed_tool")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap/stage1:defs.bzl", "c_library", "c_object", "compiler")
load("@cellar//bootstrap/stage1/linux-headers:defs.bzl", LINUX_DIRECTORIES = "DIRECTORIES")
load("@cellar//bootstrap/stage1/musl12:sources.bzl", "ARCH_SOURCES", "BASE_C_SOURCES", "CRT_SOURCES", "PUBLIC_HEADERS")
load(":defs.bzl", "CAPTURE", "SED", "SOURCE")
load(":inventory.bzl", "LLVM_VERSION", "RUNTIME_LISTS")

TRIPLE = "x86_64-unknown-linux-musl"

MUSL = "cellar//bootstrap/stage1/musl12"

LINUX = "cellar//bootstrap/stage1/linux-headers"

MIMALLOC = "cellar//bootstrap/stage1/mimalloc"

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

def _source(path):
    return "$(location {})/{}".format(SOURCE, path)

def _cmake_configure(values):
    """sed arguments doing what CMake's configure_file does with values.

    A string sets a variable, True sets it to a true value and False leaves
    it unset. A template line naming a variable not in values survives as a
    #cmakedefine, which no compiler accepts.
    """
    args = []
    for name, value in values.items():
        if value == False:
            expressions = [
                "s|^#cmakedefine01 {0}$|#define {0} 0|",
                "s|^#cmakedefine {0}$|/* #undef {0} */|",
                "s|^#cmakedefine {0} .*$|/* #undef {0} */|",
                "s|@{0}@||g",
            ]
        else:
            expressions = [
                "s|^#cmakedefine01 {0}$|#define {0} 1|",
                "s|^#cmakedefine {0}$|#define {0}|",
                "s|^#cmakedefine {0} |#define {0} |",
                "s|@{0}@|" + ("1" if value == True else value) + "|g",
            ]
        for expression in expressions:
            args += ["-e", expression.format(name)]
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

def runtime_headers():
    """The headers libc++, libc++abi and libunwind install."""
    generate(
        name = "libcxx-config-site",
        args = _cmake_configure(LIBCXX_CONFIG_SITE) + ["$(location {}[libcxx/include/__config_site.in])".format(SOURCE)],
        capture = CAPTURE,
        output = "__config_site",
        tool = SED,
    )

    # With per-target runtime directories, __config_site stays out of the
    # module map.
    generate(
        name = "libcxx-module-map",
        args = _cmake_configure({"LIBCXX_CONFIG_SITE_MODULE_ENTRY": False}) + ["$(location {}[libcxx/include/module.modulemap.in])".format(SOURCE)],
        capture = CAPTURE,
        output = "module.modulemap",
        tool = SED,
    )

    # libc++abi installs its headers beside libc++'s.
    filegroup(
        name = "libcxx-headers",
        srcs = {
            "c++/v1/" + path: "{}[libcxx/include/{}]".format(SOURCE, path)
            for path in RUNTIME_LISTS["libcxx/include"]["files"]
        } | {
            "c++/v1/" + path: "{}[libcxxabi/include/{}]".format(SOURCE, path)
            for path in RUNTIME_LISTS["libcxxabi/include"]["files"]
        } | {
            "c++/v1/__assertion_handler": SOURCE + "[libcxx/vendor/llvm/default_assertion_handler.in]",
            "c++/v1/module.modulemap": ":libcxx-module-map",
            TRIPLE + "/c++/v1/__config_site": ":libcxx-config-site",
        },
    )

    filegroup(
        name = "libunwind-headers",
        srcs = {
            path: "{}[libunwind/include/{}]".format(SOURCE, path)
            for path in RUNTIME_LISTS["libunwind/include"]["files"]
        },
    )

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
    """Every tarball path the runtimes project out of the extracted source."""
    return sorted(BUILTINS_SOURCES + LIBUNWIND_SOURCES + LIBCXXABI_SOURCES + LIBCXX_SOURCES + LIBCXX_EXPERIMENTAL_SOURCES + [
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
        "compiler-rt/LICENSE.TXT",
        "libcxx/LICENSE.TXT",
        "libcxx/include/__config_site.in",
        "libcxx/include/module.modulemap.in",
        "libcxx/vendor/llvm/default_assertion_handler.in",
        "libcxxabi/LICENSE.TXT",
        "libunwind/LICENSE.TXT",
    ])

def clang_compilers(stage, tree, archiver):
    """The compilers that build a stage: the Clang, LLD and resource headers
    in tree, with archiver as their llvm-ar.

    stage-cc compiles C against musl and the kernel headers, stage-c++ adds
    libc++, and stage-bare-cc names no headers, for musl itself.
    """
    installed_tool(
        name = stage + "-driver",
        installation = tree,
        path = "bin/clang",
    )
    installed_tool(
        name = stage + "-linker",
        installation = tree,
        path = "bin/ld.lld",
    )
    for name, includes in {
        "bare-cc": [],
        "cc": C_INCLUDES,
        "c++": CXX_INCLUDES + C_INCLUDES,
    }.items():
        compiler(
            name = "{}-{}".format(stage, name),
            abi = "x86_64-sysv",
            archive_flags = ["crsD"],
            archive_format = "ar",
            archiver = archiver,
            cflags = REPRODUCIBLE_FLAGS + includes,
            compiler = ":{}-driver".format(stage),
            family = "clang",
            # libunwind finds the unwind tables of a static program through
            # PT_GNU_EH_FRAME, as Clang's driver always asks LLD to write.
            ldflags = [
                "-static",
                "--eh-frame-hdr",
            ],
            linker = ":{}-linker".format(stage),
            object_format = "elf64-x86-64",
            stage = "clang-for-" + stage,
            target_compatible_with = [
                "cellar//bootstrap/platforms:linux",
                "cellar//bootstrap/platforms:amd64",
            ],
        )

def _library(stage, name, output, sources, toolchain, flags):
    """An archive of one object per source, named after it; flags maps an
    extension to the flags of its sources."""
    objects = []
    for i, path in enumerate(sources):
        target = "{}-{}-{}".format(stage, name, i)
        c_object(
            name = target,
            src = "{}[{}]".format(SOURCE, path),
            flags = flags[path.rsplit(".", 1)[1]],
            headers = [SOURCE],
            object_name = path.rsplit("/", 1)[1].rsplit(".", 1)[0] + ".o",
            toolchain = toolchain,
        )
        objects.append(":" + target)
    if output:
        c_library(
            name = "{}-{}".format(stage, output),
            objects = objects,
            output = output,
            toolchain = toolchain,
        )
    return objects

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

MUSL_INCLUDES = [
    MUSL + ":source[arch/x86_64]",
    MUSL + ":source[arch/generic]",
    MUSL + ":source[src/include]",
    MUSL + ":source[src/internal]",
    MUSL + ":source[include]",
]

MUSL_REPLACED = [path.replace("/x86_64/", "/").rsplit(".", 1)[0] + ".c" for path in ARCH_SOURCES]

MUSL_LIBC_SOURCES = sorted([path for path in BASE_C_SOURCES if path not in MUSL_REPLACED] + ARCH_SOURCES)

# musl installs these empty, for programs that name them.
MUSL_EMPTY_LIBRARIES = [
    "m",
    "rt",
    "pthread",
    "crypt",
    "util",
    "xnet",
    "resolv",
    "dl",
]

def _musl(stage):
    objects = []
    for i, path in enumerate(MUSL_LIBC_SOURCES):
        directory = path.rsplit("/", 1)[0] + "/"
        c_object(
            name = "{}-musl-{}".format(stage, i),
            src = "{}:source[{}]".format(MUSL, path),
            defines = ["_XOPEN_SOURCE=700"],
            flags = MUSL_FLAGS + (["-O3"] if directory in MUSL_OPTIMIZED else []),
            headers = [MUSL + ":source"],
            includes = MUSL_INCLUDES,
            object_name = "{}.o".format(i),
            toolchain = ":{}-bare-cc".format(stage),
        )
        objects.append(":{}-musl-{}".format(stage, i))
    c_library(
        name = stage + "-libc.a",
        objects = objects,
        output = "libc.a",
        toolchain = ":{}-bare-cc".format(stage),
    )
    for name in MUSL_EMPTY_LIBRARIES:
        c_library(
            name = "{}-lib{}.a".format(stage, name),
            objects = [],
            output = "lib{}.a".format(name),
            toolchain = ":{}-bare-cc".format(stage),
        )
    for path in CRT_SOURCES:
        name = path.rsplit("/", 1)[1].rsplit(".", 1)[0]
        c_object(
            name = "{}-{}.o".format(stage, name),
            src = "{}:source[{}]".format(MUSL, path),
            defines = [
                "CRT",
                "_XOPEN_SOURCE=700",
            ],
            flags = MUSL_FLAGS,
            headers = [MUSL + ":source"],
            includes = MUSL_INCLUDES,
            object_name = name + ".o",
            toolchain = ":{}-bare-cc".format(stage),
        )

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
    _source("third-party/siphash/include"),
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
    _source("libunwind/include"),
]

LIBCXXABI_FLAGS = [
    "-std=c++23",
    "-O2",
    "-fstrict-aliasing",
    "-fsized-deallocation",
    "-D_DEBUG",
    "-D_LIBCXXABI_BUILDING_LIBRARY",
    "-D_LIBCPP_BUILDING_LIBRARY",
    "-D_LIBCPP_AVAILABILITY_MINIMUM_HEADER_VERSION=2",
    "-I",
    _source("libcxxabi/include"),
    "-I",
    _source("libcxx/src"),
    "-I",
    _source("libunwind/include"),
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

def llvm_runtimes(stage):
    """The C library and runtimes the stage's compilers build.

    stage-libc.a and musl's startup files, stage-libclang_rt.builtins.a,
    stage-clang_rt.crtbegin.o and crtend.o, stage-libunwind.a,
    stage-libc++abi.a, stage-libc++.a, which also holds libc++abi as
    LIBCXX_ENABLE_STATIC_ABI_LIBRARY arranges, stage-libc++experimental.a
    and stage-mimalloc.o.
    """
    cc = ":{}-cc".format(stage)
    cxx = ":{}-c++".format(stage)
    _musl(stage)
    _library(stage, "builtins", "libclang_rt.builtins.a", BUILTINS_SOURCES, cc, {
        "c": BUILTINS_FLAGS,
        "S": BUILTINS_FLAGS,
    })
    for name in CRT_OBJECTS:
        c_object(
            name = "{}-clang_rt.{}.o".format(stage, name),
            src = "{}[compiler-rt/lib/builtins/{}.c]".format(SOURCE, name),
            flags = CRT_FLAGS,
            object_name = "clang_rt.{}.o".format(name),
            toolchain = cc,
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
    })
    abi = _library(stage, "libcxxabi", "libc++abi.a", LIBCXXABI_SOURCES, cxx, {"cpp": LIBCXXABI_FLAGS})
    cxx_objects = _library(stage, "libcxx", None, LIBCXX_SOURCES, cxx, {"cpp": LIBCXX_FLAGS + [
        "-DLIBCXX_BUILDING_LIBCXXABI",
        "-DLIBC_NAMESPACE=__llvm_libc_common_utils",
        "-I",
        _source("libcxx/src"),
        "-I",
        _source("libcxxabi/include"),
        "-isystem",
        _source("libc"),
    ]})
    c_library(
        name = stage + "-libc++.a",
        objects = cxx_objects + abi,
        output = "libc++.a",
        toolchain = cxx,
    )
    _library(stage, "libcxx-experimental", "libc++experimental.a", LIBCXX_EXPERIMENTAL_SOURCES, cxx, {"cpp": LIBCXX_FLAGS + [
        "-D_LIBCPP_ENABLE_EXPERIMENTAL",
    ]})

    # As mimalloc's own package builds it for GCC 13.
    c_object(
        name = stage + "-mimalloc.o",
        src = MIMALLOC + ":mimalloc-3.5.3[src/static.c]",
        defines = [
            "MI_MALLOC_OVERRIDE=1",
            "NDEBUG",
        ],
        flags = [
            "-std=gnu11",
            "-O2",
            "-fno-builtin-malloc",
        ],
        headers = [MIMALLOC + ":mimalloc-3.5.3"],
        includes = [MIMALLOC + ":mimalloc-3.5.3[include]"],
        object_name = "mimalloc.o",
        toolchain = cc,
    )

def runtime_link(stage):
    """How a program links statically against a stage's runtimes."""
    return {
        "end_objects": [
            ":{}-clang_rt.crtend.o".format(stage),
            ":{}-crtn.o".format(stage),
        ],
        "libraries": [
            ":{}-libc++.a".format(stage),
            ":{}-libunwind.a".format(stage),
            ":{}-libc.a".format(stage),
            ":{}-libclang_rt.builtins.a".format(stage),
            ":{}-libc.a".format(stage),
        ],
        "objects": [
            ":{}-crt1.o".format(stage),
            ":{}-crti.o".format(stage),
            ":{}-clang_rt.crtbegin.o".format(stage),
        ],
    }

# musl's installed headers: its include directory with the x86_64 and generic
# architecture headers merged in, and the two it generates.
MUSL_HEADERS = sorted({
    path.removeprefix(prefix): None
    for prefix in [
        "include/",
        "arch/generic/",
        "arch/x86_64/",
    ]
    for path in PUBLIC_HEADERS
    if path.startswith(prefix)
}.keys() + [
    "bits/alltypes.h",
    "bits/syscall.h",
])

# libunwind's own interface. Clang searches a musl sysroot's headers before
# its resource directory, whose <unwind.h> has the definitions GCC's also
# has, such as _Unwind_Ptr, so libunwind's Itanium headers stay out.
LIBUNWIND_INSTALLED_HEADERS = [
    "__libunwind_config.h",
    "libunwind.h",
]

def runtime_installation(stage):
    """Where a stage's C library, headers and runtimes lie in an installation
    that is its own sysroot, as Clang's driver looks for them."""
    resource = "lib/clang/{}/lib/{}/".format(LLVM_VERSION.split(".")[0], TRIPLE)
    files = {
        resource + "libclang_rt.builtins.a": ":{}-libclang_rt.builtins.a".format(stage),
        resource + "clang_rt.crtbegin.o": ":{}-clang_rt.crtbegin.o".format(stage),
        resource + "clang_rt.crtend.o": ":{}-clang_rt.crtend.o".format(stage),
        "include/c++": ":libcxx-headers[c++]",
        "include/{}/c++".format(TRIPLE): ":libcxx-headers[{}/c++]".format(TRIPLE),
        "lib/libc.a": ":{}-libc.a".format(stage),
    }
    for library in [
        "libc++.a",
        "libc++abi.a",
        "libc++experimental.a",
        "libunwind.a",
    ]:
        files["lib/{}/{}".format(TRIPLE, library)] = ":{}-{}".format(stage, library)
    for name in MUSL_EMPTY_LIBRARIES:
        files["lib/lib{}.a".format(name)] = ":{}-lib{}.a".format(stage, name)
    for name in [
        "crt1",
        "crti",
        "crtn",
    ]:
        files["lib/{}.o".format(name)] = ":{}-{}.o".format(stage, name)
    for path in MUSL_HEADERS:
        files["include/" + path] = "{}:headers[{}]".format(MUSL, path)
    for directory in LINUX_DIRECTORIES:
        files["include/" + directory] = "{}:headers[{}]".format(LINUX, directory)
    for path in LIBUNWIND_INSTALLED_HEADERS:
        files["include/" + path] = ":libunwind-headers[{}]".format(path)
    return files
