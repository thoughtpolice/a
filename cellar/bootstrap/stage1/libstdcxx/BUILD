# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "command_test", "concatenate", "configured_tool", "generate")
load("@cellar//bootstrap:defs.bzl", "export_file", "filegroup")
load("@cellar//bootstrap:source.bzl", "untar", "write_file")
load("@cellar//bootstrap/stage1:defs.bzl", "c_library", "c_object")
load(":sources.bzl", "HEADER_FILES", "SOURCES")

GCC = "cellar//bootstrap/stage1/gcc47"

MUSL = "cellar//bootstrap/stage1/musl12"

STAGES = [
    "stage1",
    "stage2",
    "stage3",
]

SOURCE_ALIAS = "cellar//bootstrap/stage1/tools:source-alias"

CAPTURE = "cellar//bootstrap/stage1/tools:capture"

SED = "cellar//bootstrap/stage1/sed:sed"

untar(
    name = "gcc-4.7.4",
    chdirenv = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    files = SOURCES + ["gcc/DATESTAMP"],
    flags = [
        "--numeric-owner",
        "-xf",
    ],
    input = GCC + ":gcc.tar",
    untar = "cellar//bootstrap/stage1/tar:tar",
)

export_file(name = "patches/gthr.before")

export_file(name = "patches/gthr.after")

generate(
    name = "os_defines.h",
    args = [
        "$(location :gcc-4.7.4[libstdc++-v3/config/os/generic/os_defines.h])",
        "$(location :patches/gthr.before)",
        "$(location :patches/gthr.after)",
    ],
    tool = "cellar//bootstrap/stage1/simple-patch:simple-patch",
)

# Reviewed x86_64 musl configuration; no target configure process runs.
# Musl uses 64-bit off_t directly; the optional *64 libc aliases are absent.
CONFIG_ON = [
    "HAVE_ACOSF",
    "HAVE_ACOSL",
    "HAVE_ASINF",
    "HAVE_ASINL",
    "HAVE_AS_SYMVER_DIRECTIVE",
    "HAVE_ATAN2F",
    "HAVE_ATAN2L",
    "HAVE_ATANF",
    "HAVE_ATANL",
    "HAVE_CC_TLS",
    "HAVE_CEILF",
    "HAVE_CEILL",
    "HAVE_COMPLEX_H",
    "HAVE_COSF",
    "HAVE_COSHF",
    "HAVE_COSHL",
    "HAVE_COSL",
    "HAVE_DLFCN_H",
    "HAVE_EBADMSG",
    "HAVE_ECANCELED",
    "HAVE_ECHILD",
    "HAVE_EIDRM",
    "HAVE_ENDIAN_H",
    "HAVE_ENODATA",
    "HAVE_ENOLINK",
    "HAVE_ENOSPC",
    "HAVE_ENOSR",
    "HAVE_ENOSTR",
    "HAVE_ENOTRECOVERABLE",
    "HAVE_ENOTSUP",
    "HAVE_EOVERFLOW",
    "HAVE_EOWNERDEAD",
    "HAVE_EPERM",
    "HAVE_EPROTO",
    "HAVE_ETIME",
    "HAVE_ETIMEDOUT",
    "HAVE_ETXTBSY",
    "HAVE_EWOULDBLOCK",
    "HAVE_EXPF",
    "HAVE_EXPL",
    "HAVE_FABSF",
    "HAVE_FABSL",
    "HAVE_FENV_H",
    "HAVE_FINITE",
    "HAVE_FINITEF",
    "HAVE_FLOAT_H",
    "HAVE_FLOORF",
    "HAVE_FLOORL",
    "HAVE_FMODF",
    "HAVE_FMODL",
    "HAVE_FREXPF",
    "HAVE_FREXPL",
    "HAVE_GETS",
    "HAVE_HYPOT",
    "HAVE_HYPOTF",
    "HAVE_HYPOTL",
    "HAVE_ICONV",
    "HAVE_INT64_T",
    "HAVE_INT64_T_LONG",
    "HAVE_INTTYPES_H",
    "HAVE_ISINF",
    "HAVE_ISNAN",
    "HAVE_ISWBLANK",
    "HAVE_LC_MESSAGES",
    "HAVE_LDEXPF",
    "HAVE_LDEXPL",
    "HAVE_LIMIT_AS",
    "HAVE_LIMIT_DATA",
    "HAVE_LIMIT_FSIZE",
    "HAVE_LIMIT_RSS",
    "HAVE_LOCALE_H",
    "HAVE_LOG10F",
    "HAVE_LOG10L",
    "HAVE_LOGF",
    "HAVE_LOGL",
    "HAVE_MBSTATE_T",
    "HAVE_MEMORY_H",
    "HAVE_MODF",
    "HAVE_MODFF",
    "HAVE_MODFL",
    "HAVE_POLL",
    "HAVE_POWF",
    "HAVE_POWL",
    "HAVE_SETENV",
    "HAVE_SINCOS",
    "HAVE_SINCOSF",
    "HAVE_SINCOSL",
    "HAVE_SINF",
    "HAVE_SINHF",
    "HAVE_SINHL",
    "HAVE_SINL",
    "HAVE_SQRTF",
    "HAVE_SQRTL",
    "HAVE_STDALIGN_H",
    "HAVE_STDBOOL_H",
    "HAVE_STDINT_H",
    "HAVE_STDLIB_H",
    "HAVE_STRERROR_L",
    "HAVE_STRERROR_R",
    "HAVE_STRINGS_H",
    "HAVE_STRING_H",
    "HAVE_STRTOF",
    "HAVE_STRTOLD",
    "HAVE_STRXFRM_L",
    "HAVE_SYS_IOCTL_H",
    "HAVE_SYS_IPC_H",
    "HAVE_SYS_PARAM_H",
    "HAVE_SYS_RESOURCE_H",
    "HAVE_SYS_SEM_H",
    "HAVE_SYS_STAT_H",
    "HAVE_SYS_SYSINFO_H",
    "HAVE_SYS_TIME_H",
    "HAVE_SYS_TYPES_H",
    "HAVE_SYS_UIO_H",
    "HAVE_S_IFREG",
    "HAVE_S_ISREG",
    "HAVE_TANF",
    "HAVE_TANHF",
    "HAVE_TANHL",
    "HAVE_TANL",
    "HAVE_TGMATH_H",
    "HAVE_TLS",
    "HAVE_UNISTD_H",
    "HAVE_VFWSCANF",
    "HAVE_VSWSCANF",
    "HAVE_VWSCANF",
    "HAVE_WCHAR_H",
    "HAVE_WCSTOF",
    "HAVE_WCTYPE_H",
    "HAVE_WRITEV",
    "_GLIBCXX_ATOMIC_BUILTINS",
    "_GLIBCXX_HAS_GTHREADS",
    "_GLIBCXX_HOSTED",
    "_GLIBCXX_RES_LIMITS",
    "_GLIBCXX_USE_C99",
    "_GLIBCXX_USE_C99_COMPLEX",
    "_GLIBCXX_USE_C99_COMPLEX_TR1",
    "_GLIBCXX_USE_C99_CTYPE_TR1",
    "_GLIBCXX_USE_C99_FENV_TR1",
    "_GLIBCXX_USE_C99_INTTYPES_TR1",
    "_GLIBCXX_USE_C99_INTTYPES_WCHAR_T_TR1",
    "_GLIBCXX_USE_C99_MATH",
    "_GLIBCXX_USE_C99_MATH_TR1",
    "_GLIBCXX_USE_C99_STDINT_TR1",
    "_GLIBCXX_USE_CLOCK_MONOTONIC",
    "_GLIBCXX_USE_CLOCK_REALTIME",
    "_GLIBCXX_USE_DECIMAL_FLOAT",
    "_GLIBCXX_USE_FLOAT128",
    "_GLIBCXX_USE_GETTIMEOFDAY",
    "_GLIBCXX_USE_INT128",
    "_GLIBCXX_USE_LONG_LONG",
    "_GLIBCXX_USE_NANOSLEEP",
    "_GLIBCXX_USE_RANDOM_TR1",
    "_GLIBCXX_USE_SCHED_YIELD",
    "_GLIBCXX_USE_SC_NPROCESSORS_ONLN",
    "_GLIBCXX_USE_WCHAR_T",
    "_GTHREAD_USE_MUTEX_TIMEDLOCK",
    "STDC_HEADERS",
]

CONFIG_VALUES = {
    "SIZEOF_CHAR": "1",
    "SIZEOF_SHORT": "2",
    "SIZEOF_INT": "4",
    "SIZEOF_LONG": "8",
    "SIZEOF_VOID_P": "8",
    "ICONV_CONST": "",
    "_GLIBCXX_FULLY_DYNAMIC_STRING": "0",
    "_GLIBCXX_STDIO_EOF": "-1",
    "_GLIBCXX_STDIO_SEEK_CUR": "1",
    "_GLIBCXX_STDIO_SEEK_END": "2",
}

write_file(
    name = "config.h",
    content = "\n".join(["#define " + name + " 1" for name in CONFIG_ON]) + "\n" + "\n".join(["#define " + name + " " + value for name, value in CONFIG_VALUES.items()]) + "\n",
)

# stamp-cxx-config dates the library with gcc/DATESTAMP.
generate(
    name = "glibcxx-date.sed",
    args = [
        "-e",
        "s|^[0-9][0-9]*$|s/define __GLIBCXX__$/define __GLIBCXX__ &/|",
        "$(location :gcc-4.7.4[gcc/DATESTAMP])",
    ],
    capture = CAPTURE,
    tool = SED,
)

generate(
    name = "cxxconfig-base",
    args = [
        "-f",
        "$(location :glibcxx-date.sed)",
        "-e",
        "s/define _GLIBCXX_INLINE_VERSION *$/define _GLIBCXX_INLINE_VERSION 0/",
        "-e",
        "s/define _GLIBCXX_HAVE_ATTRIBUTE_VISIBILITY$/define _GLIBCXX_HAVE_ATTRIBUTE_VISIBILITY 1/",
        "-e",
        "s/define _GLIBCXX_EXTERN_TEMPLATE$/define _GLIBCXX_EXTERN_TEMPLATE 1/",
        "$(location :gcc-4.7.4[libstdc++-v3/include/bits/c++config])",
    ],
    capture = CAPTURE,
    tool = SED,
)

generate(
    name = "cxxconfig-settings",
    args = [
        "-e",
        "s/HAVE_/_GLIBCXX_HAVE_/g",
        "-e",
        "s/PACKAGE/_GLIBCXX_PACKAGE/g",
        "-e",
        "s/VERSION/_GLIBCXX_VERSION/g",
        "-e",
        "s/WORDS_/_GLIBCXX_WORDS_/g",
        "-e",
        "s/ICONV_CONST/_GLIBCXX_ICONV_CONST/g",
        "$(location :config.h)",
    ],
    capture = CAPTURE,
    tool = SED,
)

write_file(
    name = "cxxconfig-end",
    content = "\n#endif // _GLIBCXX_CXX_CONFIG_H\n",
)

concatenate(
    name = "c++config.h",
    inputs = [
        ":cxxconfig-base",
        ":cxxconfig-settings",
        ":cxxconfig-end",
    ],
    output = "c++config.h",
    tool = "cellar//bootstrap/stage0-posix/mescc-tools-extra:catm",
)

GTHREAD_TRANSFORMS = {
    "gthr.h": [
        "/^#pragma/b",
        "/^#/s/\\([ABCDEFGHIJKLMNOPQRSTUVWXYZ_][ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*\\)/_GLIBCXX_\\1/g",
        "s/_GLIBCXX_SUPPORTS_WEAK/__GXX_WEAK__/g",
        's,^#include "\\(.*\\)",#include <bits/\\1>,g',
    ],
    "gthr-single.h": [
        "s/\\(UNUSED\\)/_GLIBCXX_\\1/g",
        "s/\\(GCC[ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*_H\\)/_GLIBCXX_\\1/g",
    ],
    "gthr-posix.h": [
        "s/\\(UNUSED\\)/_GLIBCXX_\\1/g",
        "s/\\(GCC[ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*_H\\)/_GLIBCXX_\\1/g",
        "s/SUPPORTS_WEAK/__GXX_WEAK__/g",
        "s/\\([ABCDEFGHIJKLMNOPQRSTUVWXYZ_]*USE_WEAK\\)/_GLIBCXX_\\1/g",
    ],
}

[
    generate(
        name = name,
        args = [arg for transform in transforms for arg in [
            "-e",
            transform,
        ]] + ["$(location :gcc-4.7.4[libgcc/" + name + "])"],
        capture = CAPTURE,
        output = name,
        tool = SED,
    )
    for name, transforms in GTHREAD_TRANSFORMS.items()
]

filegroup(
    name = "headers",
    srcs = {name: ":gcc-4.7.4[" + source + "]" for name, source in HEADER_FILES.items() if name != "bits/os_defines.h"} | {
        "bits/os_defines.h": ":os_defines.h",
        "bits/c++config.h": ":c++config.h",
        "bits/gthr.h": ":gthr.h",
        "bits/gthr-single.h": ":gthr-single.h",
        "bits/gthr-posix.h": ":gthr-posix.h",
        "bits/gthr-default.h": ":gthr-posix.h",
    },
)

write_file(
    name = "gstdint.h",
    content = "#include <stdint.h>\n",
)

LIBRARY_OBJECTS = {
    "array_type_info.cc": "libstdc++-v3/libsupc++/array_type_info.cc",
    "atexit_arm.cc": "libstdc++-v3/libsupc++/atexit_arm.cc",
    "bad_alloc.cc": "libstdc++-v3/libsupc++/bad_alloc.cc",
    "bad_cast.cc": "libstdc++-v3/libsupc++/bad_cast.cc",
    "bad_typeid.cc": "libstdc++-v3/libsupc++/bad_typeid.cc",
    "class_type_info.cc": "libstdc++-v3/libsupc++/class_type_info.cc",
    "del_op.cc": "libstdc++-v3/libsupc++/del_op.cc",
    "del_opnt.cc": "libstdc++-v3/libsupc++/del_opnt.cc",
    "del_opv.cc": "libstdc++-v3/libsupc++/del_opv.cc",
    "del_opvnt.cc": "libstdc++-v3/libsupc++/del_opvnt.cc",
    "dyncast.cc": "libstdc++-v3/libsupc++/dyncast.cc",
    "eh_alloc.cc": "libstdc++-v3/libsupc++/eh_alloc.cc",
    "eh_arm.cc": "libstdc++-v3/libsupc++/eh_arm.cc",
    "eh_aux_runtime.cc": "libstdc++-v3/libsupc++/eh_aux_runtime.cc",
    "eh_call.cc": "libstdc++-v3/libsupc++/eh_call.cc",
    "eh_catch.cc": "libstdc++-v3/libsupc++/eh_catch.cc",
    "eh_exception.cc": "libstdc++-v3/libsupc++/eh_exception.cc",
    "eh_globals.cc": "libstdc++-v3/libsupc++/eh_globals.cc",
    "eh_personality.cc": "libstdc++-v3/libsupc++/eh_personality.cc",
    "eh_ptr.cc": "libstdc++-v3/libsupc++/eh_ptr.cc",
    "eh_term_handler.cc": "libstdc++-v3/libsupc++/eh_term_handler.cc",
    "eh_terminate.cc": "libstdc++-v3/libsupc++/eh_terminate.cc",
    "eh_tm.cc": "libstdc++-v3/libsupc++/eh_tm.cc",
    "eh_throw.cc": "libstdc++-v3/libsupc++/eh_throw.cc",
    "eh_type.cc": "libstdc++-v3/libsupc++/eh_type.cc",
    "eh_unex_handler.cc": "libstdc++-v3/libsupc++/eh_unex_handler.cc",
    "enum_type_info.cc": "libstdc++-v3/libsupc++/enum_type_info.cc",
    "function_type_info.cc": "libstdc++-v3/libsupc++/function_type_info.cc",
    "fundamental_type_info.cc": "libstdc++-v3/libsupc++/fundamental_type_info.cc",
    "guard.cc": "libstdc++-v3/libsupc++/guard.cc",
    "guard_error.cc": "libstdc++-v3/libsupc++/guard_error.cc",
    "hash_bytes.cc": "libstdc++-v3/libsupc++/hash_bytes.cc",
    "nested_exception.cc": "libstdc++-v3/libsupc++/nested_exception.cc",
    "new_handler.cc": "libstdc++-v3/libsupc++/new_handler.cc",
    "new_op.cc": "libstdc++-v3/libsupc++/new_op.cc",
    "new_opnt.cc": "libstdc++-v3/libsupc++/new_opnt.cc",
    "new_opv.cc": "libstdc++-v3/libsupc++/new_opv.cc",
    "new_opvnt.cc": "libstdc++-v3/libsupc++/new_opvnt.cc",
    "pbase_type_info.cc": "libstdc++-v3/libsupc++/pbase_type_info.cc",
    "pmem_type_info.cc": "libstdc++-v3/libsupc++/pmem_type_info.cc",
    "pointer_type_info.cc": "libstdc++-v3/libsupc++/pointer_type_info.cc",
    "pure.cc": "libstdc++-v3/libsupc++/pure.cc",
    "si_class_type_info.cc": "libstdc++-v3/libsupc++/si_class_type_info.cc",
    "tinfo.cc": "libstdc++-v3/libsupc++/tinfo.cc",
    "tinfo2.cc": "libstdc++-v3/libsupc++/tinfo2.cc",
    "vec.cc": "libstdc++-v3/libsupc++/vec.cc",
    "vmi_class_type_info.cc": "libstdc++-v3/libsupc++/vmi_class_type_info.cc",
    "vterminate.cc": "libstdc++-v3/libsupc++/vterminate.cc",
    "98-bitmap_allocator.cc": "libstdc++-v3/src/c++98/bitmap_allocator.cc",
    "98-pool_allocator.cc": "libstdc++-v3/src/c++98/pool_allocator.cc",
    "98-mt_allocator.cc": "libstdc++-v3/src/c++98/mt_allocator.cc",
    "98-codecvt.cc": "libstdc++-v3/src/c++98/codecvt.cc",
    "98-complex_io.cc": "libstdc++-v3/src/c++98/complex_io.cc",
    "98-ctype.cc": "libstdc++-v3/src/c++98/ctype.cc",
    "98-globals_io.cc": "libstdc++-v3/src/c++98/globals_io.cc",
    "98-hash_tr1.cc": "libstdc++-v3/src/c++98/hash_tr1.cc",
    "98-hashtable_tr1.cc": "libstdc++-v3/src/c++98/hashtable_tr1.cc",
    "98-ios.cc": "libstdc++-v3/src/c++98/ios.cc",
    "98-ios_failure.cc": "libstdc++-v3/src/c++98/ios_failure.cc",
    "98-ios_init.cc": "libstdc++-v3/src/c++98/ios_init.cc",
    "98-ios_locale.cc": "libstdc++-v3/src/c++98/ios_locale.cc",
    "98-list.cc": "libstdc++-v3/src/c++98/list.cc",
    "98-locale.cc": "libstdc++-v3/src/c++98/locale.cc",
    "98-locale_init.cc": "libstdc++-v3/src/c++98/locale_init.cc",
    "98-locale_facets.cc": "libstdc++-v3/src/c++98/locale_facets.cc",
    "98-localename.cc": "libstdc++-v3/src/c++98/localename.cc",
    "98-math_stubs_float.cc": "libstdc++-v3/src/c++98/math_stubs_float.cc",
    "98-math_stubs_long_double.cc": "libstdc++-v3/src/c++98/math_stubs_long_double.cc",
    "98-stdexcept.cc": "libstdc++-v3/src/c++98/stdexcept.cc",
    "98-strstream.cc": "libstdc++-v3/src/c++98/strstream.cc",
    "98-tree.cc": "libstdc++-v3/src/c++98/tree.cc",
    "98-istream.cc": "libstdc++-v3/src/c++98/istream.cc",
    "98-streambuf.cc": "libstdc++-v3/src/c++98/streambuf.cc",
    "98-valarray.cc": "libstdc++-v3/src/c++98/valarray.cc",
    "98-allocator-inst.cc": "libstdc++-v3/src/c++98/allocator-inst.cc",
    "98-concept-inst.cc": "libstdc++-v3/src/c++98/concept-inst.cc",
    "98-ext-inst.cc": "libstdc++-v3/src/c++98/ext-inst.cc",
    "98-ios-inst.cc": "libstdc++-v3/src/c++98/ios-inst.cc",
    "98-iostream-inst.cc": "libstdc++-v3/src/c++98/iostream-inst.cc",
    "98-istream-inst.cc": "libstdc++-v3/src/c++98/istream-inst.cc",
    "98-locale-inst.cc": "libstdc++-v3/src/c++98/locale-inst.cc",
    "98-misc-inst.cc": "libstdc++-v3/src/c++98/misc-inst.cc",
    "98-ostream-inst.cc": "libstdc++-v3/src/c++98/ostream-inst.cc",
    "98-sstream-inst.cc": "libstdc++-v3/src/c++98/sstream-inst.cc",
    "98-streambuf-inst.cc": "libstdc++-v3/src/c++98/streambuf-inst.cc",
    "98-wlocale-inst.cc": "libstdc++-v3/src/c++98/wlocale-inst.cc",
    "98-compatibility.cc": "libstdc++-v3/src/c++98/compatibility.cc",
    "98-compatibility-debug_list.cc": "libstdc++-v3/src/c++98/compatibility-debug_list.cc",
    "98-compatibility-debug_list-2.cc": "libstdc++-v3/src/c++98/compatibility-debug_list-2.cc",
    "98-compatibility-list.cc": "libstdc++-v3/src/c++98/compatibility-list.cc",
    "98-compatibility-list-2.cc": "libstdc++-v3/src/c++98/compatibility-list-2.cc",
    "11-chrono.cc": "libstdc++-v3/src/c++11/chrono.cc",
    "11-condition_variable.cc": "libstdc++-v3/src/c++11/condition_variable.cc",
    "11-debug.cc": "libstdc++-v3/src/c++11/debug.cc",
    "11-functexcept.cc": "libstdc++-v3/src/c++11/functexcept.cc",
    "11-functional.cc": "libstdc++-v3/src/c++11/functional.cc",
    "11-future.cc": "libstdc++-v3/src/c++11/future.cc",
    "11-hash_c++0x.cc": "libstdc++-v3/src/c++11/hash_c++0x.cc",
    "11-hashtable_c++0x.cc": "libstdc++-v3/src/c++11/hashtable_c++0x.cc",
    "11-limits.cc": "libstdc++-v3/src/c++11/limits.cc",
    "11-mutex.cc": "libstdc++-v3/src/c++11/mutex.cc",
    "11-placeholders.cc": "libstdc++-v3/src/c++11/placeholders.cc",
    "11-regex.cc": "libstdc++-v3/src/c++11/regex.cc",
    "11-shared_ptr.cc": "libstdc++-v3/src/c++11/shared_ptr.cc",
    "11-system_error.cc": "libstdc++-v3/src/c++11/system_error.cc",
    "11-thread.cc": "libstdc++-v3/src/c++11/thread.cc",
    "11-fstream-inst.cc": "libstdc++-v3/src/c++11/fstream-inst.cc",
    "11-string-inst.cc": "libstdc++-v3/src/c++11/string-inst.cc",
    "11-wstring-inst.cc": "libstdc++-v3/src/c++11/wstring-inst.cc",
    "11-compatibility-c++0x.cc": "libstdc++-v3/src/c++11/compatibility-c++0x.cc",
    "11-compatibility-atomic-c++0x.cc": "libstdc++-v3/src/c++11/compatibility-atomic-c++0x.cc",
    "11-compatibility-thread-c++0x.cc": "libstdc++-v3/src/c++11/compatibility-thread-c++0x.cc",
    "native-c_locale.cc": "libstdc++-v3/config/locale/generic/c_locale.cc",
    "native-codecvt_members.cc": "libstdc++-v3/config/locale/generic/codecvt_members.cc",
    "native-collate_members.cc": "libstdc++-v3/config/locale/generic/collate_members.cc",
    "native-ctype_members.cc": "libstdc++-v3/config/locale/generic/ctype_members.cc",
    "native-numeric_members.cc": "libstdc++-v3/config/locale/generic/numeric_members.cc",
    "native-messages_members.cc": "libstdc++-v3/config/locale/generic/messages_members.cc",
    "native-time_members.cc": "libstdc++-v3/config/locale/generic/time_members.cc",
    "native-monetary_members.cc": "libstdc++-v3/config/locale/generic/monetary_members.cc",
    "native-ctype.cc": "libstdc++-v3/config/os/generic/ctype_configure_char.cc",
    "native-basic_file.cc": "libstdc++-v3/config/io/basic_file_stdio.cc",
    "native-atomicity.cc": "libstdc++-v3/config/cpu/generic/atomicity_builtins/atomicity.h",
}

SUPCXX_OBJECTS = [
    "array_type_info.cc",
    "atexit_arm.cc",
    "bad_alloc.cc",
    "bad_cast.cc",
    "bad_typeid.cc",
    "class_type_info.cc",
    "del_op.cc",
    "del_opnt.cc",
    "del_opv.cc",
    "del_opvnt.cc",
    "dyncast.cc",
    "eh_alloc.cc",
    "eh_arm.cc",
    "eh_aux_runtime.cc",
    "eh_call.cc",
    "eh_catch.cc",
    "eh_exception.cc",
    "eh_globals.cc",
    "eh_personality.cc",
    "eh_ptr.cc",
    "eh_term_handler.cc",
    "eh_terminate.cc",
    "eh_tm.cc",
    "eh_throw.cc",
    "eh_type.cc",
    "eh_unex_handler.cc",
    "enum_type_info.cc",
    "function_type_info.cc",
    "fundamental_type_info.cc",
    "guard.cc",
    "guard_error.cc",
    "hash_bytes.cc",
    "nested_exception.cc",
    "new_handler.cc",
    "new_op.cc",
    "new_opnt.cc",
    "new_opv.cc",
    "new_opvnt.cc",
    "pbase_type_info.cc",
    "pmem_type_info.cc",
    "pointer_type_info.cc",
    "pure.cc",
    "si_class_type_info.cc",
    "tinfo.cc",
    "tinfo2.cc",
    "vec.cc",
    "vmi_class_type_info.cc",
    "vterminate.cc",
]

# Each target library is built by the new compiler, not its predecessor.
[filegroup(
    name = stage + "-source",
    srcs = {path: ":gcc-4.7.4[" + path + "]" for path in SOURCES} | {
        "headers": ":headers",
        "config.h": ":config.h",
        "gstdint.h": ":gstdint.h",
        "gcc-include": GCC + ":" + stage + "-library-source[include]",
    },
) for stage in STAGES]

LIBRARY_INCLUDES = [
    "headers",
    "headers/backward",
    "libstdc++-v3/libsupc++",
    "libstdc++-v3/src/c++98",
    "libstdc++-v3/src/c++11",
    "gcc-include",
    "libgcc",
    ".",
]

CXX11_SUPCXX = [
    "eh_ptr.cc",
    "eh_throw.cc",
    "guard.cc",
    "nested_exception.cc",
]

LIBRARY_FLAGS = [
    "-O2",
    "-g0",
    "-fPIC",
    "-Werror",
]

[c_object(
    name = stage + "-" + name + ".o",
    src = ":" + stage + "-source[" + source + "]",
    defines = ["_GNU_SOURCE=1"] + (["_GLIBCXX_CONCEPT_CHECKS=1"] if name == "98-concept-inst.cc" else []),
    flags = LIBRARY_FLAGS + [
                "-x",
                "c++",
                "-std=gnu++11" if name.startswith("11-") or name in CXX11_SUPCXX else "-std=gnu++98",
            ] + (["-fno-implicit-templates"] if name not in SUPCXX_OBJECTS else []) +
            (["-fimplicit-templates"] if name == "98-concept-inst.cc" else []) +
            (["-Wno-deprecated"] if name == "98-strstream.cc" else []),
    logical_includes = LIBRARY_INCLUDES,
    logical_source = source,
    object_name = "cx" + str(i) + ".o",
    source_alias = SOURCE_ALIAS,
    source_tree = ":" + stage + "-source",
    toolchain = GCC + ":" + stage + "-gcc",
) for stage in STAGES for i, (name, source) in enumerate(LIBRARY_OBJECTS.items())]

[c_object(
    name = stage + "-cp-demangle.o",
    src = ":" + stage + "-source[libiberty/cp-demangle.c]",
    defines = [
        "HAVE_CONFIG_H=1",
        "IN_GLIBCPP_V3=1",
        "_GNU_SOURCE=1",
    ],
    flags = LIBRARY_FLAGS,
    logical_includes = LIBRARY_INCLUDES,
    logical_source = "libiberty/cp-demangle.c",
    object_name = "demangle.o",
    source_alias = SOURCE_ALIAS,
    source_tree = ":" + stage + "-source",
    toolchain = GCC + ":" + stage + "-gcc",
) for stage in STAGES]

[c_library(
    name = stage + "-lib" + library + ".a",
    objects = [":" + stage + "-" + name + ".o" for name in names] + [":" + stage + "-cp-demangle.o"],
    output = "lib" + library + ".a",
    toolchain = GCC + ":" + stage + "-gcc",
) for stage in STAGES for library, names in {
    "stdc++": LIBRARY_OBJECTS.keys(),
    "supc++": SUPCXX_OBJECTS,
}.items()]

[filegroup(
    name = stage + "-libraries",
    srcs = {
        "libstdc++.a": ":" + stage + "-libstdc++.a",
        "libsupc++.a": ":" + stage + "-libsupc++.a",
    },
) for stage in STAGES]

[configured_tool(
    name = stage + "-g++",
    args = [
        "-B$(location " + GCC + ":" + stage + "-native-tools)/",
        "-B$(location " + GCC + ":" + stage + "-runtime)/lib/",
        "-L$(location :" + stage + "-libraries)",
        "-nostdinc",
        "-nostdinc++",
        "-isystem",
        "$(location :headers)",
        "-isystem",
        "$(location " + GCC + ":compiler-headers)",
        "-isystem",
        "$(location " + GCC + ":" + stage + "-runtime[include])",
    ],
    env = {"TMPDIR": "."},
    env_tool = "cellar//bootstrap/stage1/tools:withenv",
    tool = GCC + ":" + stage + "-g++",
) for stage in STAGES]

[filegroup(
    name = stage + "-installation",
    srcs = {
        "include/c++/4.7.4": ":headers",
        "lib/libstdc++.a": ":" + stage + "-libstdc++.a",
        "lib/libsupc++.a": ":" + stage + "-libsupc++.a",
        "share/licenses/libstdc++/COPYING3": ":gcc-4.7.4[COPYING3]",
        "share/licenses/libstdc++/COPYING.RUNTIME": ":gcc-4.7.4[COPYING.RUNTIME]",
    },
) for stage in STAGES]

TESTS = {
    "exceptions": "gnu++11",
    "supcxx": "gnu++98",
    "containers": "gnu++98",
    "cxx11": "gnu++11",
    "threads": "gnu++11",
    "streams": "gnu++98",
}

filegroup(
    name = "tests",
    srcs = {"tests/" + name: "tests/" + name for name in [
        "exception.h",
        "supcxx.cc",
        "throw.cc",
        "exceptions.cc",
        "containers.cc",
        "cxx11.cc",
        "threads.cc",
        "streams.cc",
    ]},
)

[generate(
    name = stage + "-" + name + "-" + optimization + "-program",
    args = [
        "-" + optimization,
        "-g0",
        "-frandom-seed=bootstrap",
        "-Werror",
        "-std=" + standard,
        "source/tests/" + name + ".cc",
    ] + (["-pthread"] if name == "threads" else []) + (["source/tests/throw.cc"] if name in [
        "exceptions",
        "supcxx",
    ] else []) + ([
        "-nodefaultlibs",
        "-Wl,--start-group",
        "-lsupc++",
        "-lgcc",
        "-lc",
        "-Wl,--end-group",
    ] if name == "supcxx" else []) + [
        "-o",
        "program",
    ],
    chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
    directory = True,
    files = ["program"],
    source_alias = SOURCE_ALIAS,
    source_tree = ":tests",
    tool = ":" + stage + "-g++",
) for stage in STAGES for name, standard in TESTS.items() for optimization in [
    "O0",
    "O2",
]]

[command_test(
    name = stage + "-" + name + "-" + optimization,
    args = [
        "0",
        "$(location :" + stage + "-" + name + "-" + optimization + "-program[program])",
    ],
    tool = "cellar//bootstrap/stage1/tools:expect-exit",
) for stage in STAGES for name in TESTS if name != "streams" for optimization in [
    "O0",
    "O2",
]]

write_file(
    name = "passed",
    content = "passed\n",
)

[[
    generate(
        name = stage + "-streams-" + optimization + "-work",
        args = [
            "0",
            "$(location :" + stage + "-streams-" + optimization + "-program[program])",
        ],
        chdir = "cellar//bootstrap/stage0-posix/cellar-extra:chdirenv",
        directory = True,
        files = ["passed"],
        tool = "cellar//bootstrap/stage1/tools:expect-exit",
    ),
    command_test(
        name = stage + "-streams-" + optimization,
        args = [
            "$(location :" + stage + "-streams-" + optimization + "-work[passed])",
            "$(location :passed)",
        ],
        tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
    ),
] for stage in STAGES for optimization in [
    "O0",
    "O2",
]]

[command_test(
    name = "compare-" + name,
    args = [
        "$(location :stage2-" + name + ")",
        "$(location :stage3-" + name + ")",
    ],
    tool = "cellar//bootstrap/stage0-posix/cellar-extra:bytecmp",
) for name in [name + ".o" for name in LIBRARY_OBJECTS] + [
    "cp-demangle.o",
    "libstdc++.a",
    "libsupc++.a",
]]

filegroup(
    name = "stage-comparison",
    srcs = {},
    tests = [
        ":compare-" + name
        for name in [name + ".o" for name in LIBRARY_OBJECTS] + [
            "cp-demangle.o",
            "libstdc++.a",
            "libsupc++.a",
        ]
    ],
)
