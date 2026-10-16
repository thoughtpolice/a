# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

# The tests `make check` runs on these targets, from every testsuite/ suite
# but libffi.bhaible (which needs a build per -DDGTEST case to check itself):
# one program per file, each of which aborts on a failed check. Regenerate
# the lists when moving to a new release.
CALL_TESTS = [
    "align_mixed",
    "align_stdcall",
    "bpo_38748",
    "callback",
    "callback2",
    "callback3",
    "callback4",
    "closure_thiscall_fastcall_pop",
    "err_bad_typedef",
    "float",
    "float1",
    "float2",
    "float3",
    "float4",
    "float_va",
    "i128-1",
    "large_struct_by_value",
    "longjmp",
    "many",
    "many2",
    "many_double",
    "many_large_structs",
    "many_mixed",
    "many_small_structs",
    "negint",
    "offsets",
    "overread",
    "plan",
    "plan_mixed",
    "plan_size",
    "plan_spill",
    "plan_struct",
    "plan_var",
    "pr1172638",
    "promotion",
    "pyobjc_tc",
    "return_dbl",
    "return_dbl1",
    "return_dbl2",
    "return_fl",
    "return_fl1",
    "return_fl2",
    "return_fl3",
    "return_ldl",
    "return_ll",
    "return_ll1",
    "return_sc",
    "return_sl",
    "return_uc",
    "return_ul",
    "s55",
    "strlen",
    "strlen2",
    "strlen3",
    "strlen4",
    "struct1",
    "struct10",
    "struct2",
    "struct3",
    "struct4",
    "struct5",
    "struct6",
    "struct7",
    "struct8",
    "struct9",
    "struct_by_value_2",
    "struct_by_value_3",
    "struct_by_value_3f",
    "struct_by_value_4",
    "struct_by_value_4f",
    "struct_by_value_big",
    "struct_by_value_small",
    "struct_int_float",
    "struct_return_2H",
    "struct_return_8H",
    "uninitialized",
    "va_1",
    "va_2",
    "va_3",
    "va_struct1",
    "va_struct2",
    "va_struct3",
    "x32",
]

CLOSURES_TESTS = [
    "closure_fn0",
    "closure_fn1",
    "closure_fn2",
    "closure_fn3",
    "closure_fn4",
    "closure_fn5",
    "closure_fn6",
    "closure_loc_fn0",
    "closure_simple",
    "cls_12byte",
    "cls_16byte",
    "cls_18byte",
    "cls_19byte",
    "cls_1_1byte",
    "cls_20byte",
    "cls_20byte1",
    "cls_24byte",
    "cls_2byte",
    "cls_3_1byte",
    "cls_3byte1",
    "cls_3byte2",
    "cls_3float",
    "cls_4_1byte",
    "cls_4byte",
    "cls_5_1_byte",
    "cls_5byte",
    "cls_64byte",
    "cls_6_1_byte",
    "cls_6byte",
    "cls_7_1_byte",
    "cls_7byte",
    "cls_8byte",
    "cls_9byte1",
    "cls_9byte2",
    "cls_align_double",
    "cls_align_float",
    "cls_align_longdouble",
    "cls_align_longdouble_split",
    "cls_align_longdouble_split2",
    "cls_align_pointer",
    "cls_align_sint16",
    "cls_align_sint32",
    "cls_align_sint64",
    "cls_align_uint16",
    "cls_align_uint32",
    "cls_align_uint64",
    "cls_dbls_struct",
    "cls_double",
    "cls_double_va",
    "cls_float",
    "cls_longdouble",
    "cls_longdouble_va",
    "cls_many_mixed_args",
    "cls_many_mixed_float_double",
    "cls_multi_schar",
    "cls_multi_sshort",
    "cls_multi_sshortchar",
    "cls_multi_uchar",
    "cls_multi_ushort",
    "cls_multi_ushortchar",
    "cls_pointer",
    "cls_pointer_stack",
    "cls_schar",
    "cls_sint",
    "cls_sshort",
    "cls_struct_va1",
    "cls_uchar",
    "cls_uint",
    "cls_uint_va",
    "cls_ulong_va",
    "cls_ulonglong",
    "cls_ushort",
    "err_bad_abi",
    "huge_struct",
    "nested_struct",
    "nested_struct1",
    "nested_struct10",
    "nested_struct11",
    "nested_struct12",
    "nested_struct13",
    "nested_struct2",
    "nested_struct3",
    "nested_struct4",
    "nested_struct5",
    "nested_struct6",
    "nested_struct7",
    "nested_struct8",
    "nested_struct9",
    "problem1",
    "single_entry_structs1",
    "single_entry_structs2",
    "single_entry_structs3",
    "stret_large",
    "stret_large2",
    "stret_medium",
    "stret_medium2",
    "testclosure",
]

COMPLEX_TESTS = [
    "cls_align_complex_double",
    "cls_align_complex_float",
    "cls_align_complex_longdouble",
    "cls_complex_double",
    "cls_complex_float",
    "cls_complex_longdouble",
    "cls_complex_struct_double",
    "cls_complex_struct_float",
    "cls_complex_struct_longdouble",
    "cls_complex_va_double",
    "cls_complex_va_float",
    "cls_complex_va_longdouble",
    "complex_double",
    "complex_float",
    "complex_i128",
    "complex_int",
    "complex_longdouble",
    "many_complex_double",
    "many_complex_float",
    "many_complex_longdouble",
    "return_complex1_double",
    "return_complex1_float",
    "return_complex1_longdouble",
    "return_complex2_double",
    "return_complex2_float",
    "return_complex2_longdouble",
    "return_complex_double",
    "return_complex_float",
    "return_complex_longdouble",
]

VECTOR_TESTS = [
    "cls_vector",
    "vector_args_spill",
    "vector_double2",
    "vector_double4",
    "vector_float32x2",
    "vector_float32x4",
    "vector_hva",
    "vector_int32x4",
    "vector_validate",
    "vector_vec3",
]

TESTS = (
    ["call/{}.c".format(t) for t in CALL_TESTS] +
    ["closures/{}.c".format(t) for t in CLOSURES_TESTS] + [
        "closures/unwindtest.cc",
        "closures/unwindtest_ffi_call.cc",
    ] + ["complex/{}.c".format(t) for t in COMPLEX_TESTS] + [
        "go/aa-direct.c",
        "go/closure1.c",
        "threads/tsan.c",
    ] + ["vector/{}.c".format(t) for t in VECTOR_TESTS]
)

# Go closures are off on Apple arm64, where x18 is reserved, and tsan.c needs
# pthread barriers, which macOS lacks.
TEST_COMPATIBILITY = {
    "go/aa-direct.c": {"compatible_with": [
        "config//os:linux",
        "config//cpu:x86_64",
    ]},
    "go/closure1.c": {"compatible_with": [
        "config//os:linux",
        "config//cpu:x86_64",
    ]},
    "threads/tsan.c": {"target_compatible_with": ["config//os:linux"]},
}

test_name = lambda path: "test-" + path.rsplit(".", 1)[0].replace("/", "-")

shims.http_archive(
    name = "src",
    sha256 = "7da3e2d9a171eb0a038f592ecad3ff2bb2550f3496d87b3b29ad0cf4430c0db4",
    strip_prefix = "libffi-{}".format(VERSION),
    sub_targets = [
        "include/ffi.h.in",
        "include/ffi_cfi.h",
        "include/ffi_common.h",
        "include/tramp.h",
        "src/aarch64/ffi.c",
        "src/aarch64/ffitarget.h",
        "src/aarch64/internal.h",
        "src/aarch64/sysv.S",
        "src/closures.c",
        "src/dlmalloc.c",
        "src/java_raw_api.c",
        "src/prep_cif.c",
        "src/raw_api.c",
        "src/tramp.c",
        "src/types.c",
        "src/x86/asmnames.h",
        "src/x86/ffi64.c",
        "src/x86/ffitarget.h",
        "src/x86/ffiw64.c",
        "src/x86/internal64.h",
        "src/x86/unix64.S",
        "src/x86/win64.S",
    ] + ["testsuite/libffi." + path for path in TESTS],
    type = "tar.gz",
    urls = [
        "https://github.com/libffi/libffi/releases/download/v{0}/libffi-{0}.tar.gz".format(VERSION),
    ],
)

# include/ffi.h is configure's substitution into include/ffi.h.in of the
# target's name, whether long double is wider than double, and whether
# closures come from a trampoline table (Apple arm64, which can't map memory
# both writable and executable). A release that adds a substitution fails
# the grep here rather than a compile.
VERSION_PARTS = [int(n) for n in VERSION.split(".")]

FFI_VERSION_NUMBER = VERSION_PARTS[0] * 10000 + VERSION_PARTS[1] * 100 + VERSION_PARTS[2]

ffi_h_cmd = lambda target, long_double, trampoline_table: " ".join(
    ["sed"] +
    ["-e 's/@{}@/{}/g'".format(k, v) for k, v in {
        "FFI_EXEC_TRAMPOLINE_TABLE": trampoline_table,
        "FFI_VERSION_NUMBER": FFI_VERSION_NUMBER,
        "FFI_VERSION_STRING": VERSION,
        "HAVE_LONG_DOUBLE": long_double,
        "TARGET": target,
        "VERSION": VERSION,
    }.items()] + [
        "$SRCS > $OUT && ! grep '@[A-Z_]*@' $OUT",
    ],
)

shims.genrule(
    name = "ffi.h",
    srcs = [":src[include/ffi.h.in]"],
    out = "ffi.h",
    cmd = shims.select({
        "config//os:linux": shims.select({
            "config//cpu:arm64": ffi_h_cmd("AARCH64", "1", "0"),
            "config//cpu:x86_64": ffi_h_cmd("X86_64", "1", "0"),
        }),
        "config//os:macos": shims.select({
            "config//cpu:arm64": ffi_h_cmd("AARCH64", "0", "1"),
            "config//cpu:x86_64": ffi_h_cmd("X86_64", "1", "0"),
        }),
    }),
)

# configure.host's sources for each cpu. x86_64 builds the Windows calling
# convention too, for FFI_WIN64 and FFI_GNUW64 calls on Unix.
shims.cxx_library(
    name = "libffi",
    srcs = [
        ":src[src/closures.c]",
        ":src[src/java_raw_api.c]",
        ":src[src/prep_cif.c]",
        ":src[src/raw_api.c]",
        ":src[src/tramp.c]",
        ":src[src/types.c]",
    ] + shims.select({
        "config//cpu:arm64": [
            ":src[src/aarch64/ffi.c]",
            ":src[src/aarch64/sysv.S]",
        ],
        "config//cpu:x86_64": [
            ":src[src/x86/ffi64.c]",
            ":src[src/x86/ffiw64.c]",
            ":src[src/x86/unix64.S]",
            ":src[src/x86/win64.S]",
        ],
    }),
    # configure adds -fexceptions for GCC-compatible compilers, so C++
    # exceptions unwind through ffi_call and closures.
    compiler_flags = ["-fexceptions"],
    exported_headers = shims.select({
        "config//cpu:arm64": {
            "ffi.h": ":ffi.h",
            "ffitarget.h": ":src[src/aarch64/ffitarget.h]",
        },
        "config//cpu:x86_64": {
            "ffi.h": ":ffi.h",
            "ffitarget.h": ":src[src/x86/ffitarget.h]",
        },
    }),
    header_namespace = "",
    headers = shims.select({
        "config//cpu:arm64": {
            "dlmalloc.c": ":src[src/dlmalloc.c]",
            "ffi_cfi.h": ":src[include/ffi_cfi.h]",
            "ffi_common.h": ":src[include/ffi_common.h]",
            "fficonfig.h": "fficonfig.h",
            "internal.h": ":src[src/aarch64/internal.h]",
            "tramp.h": ":src[include/tramp.h]",
        },
        "config//cpu:x86_64": {
            "asmnames.h": ":src[src/x86/asmnames.h]",
            "dlmalloc.c": ":src[src/dlmalloc.c]",
            "ffi_cfi.h": ":src[include/ffi_cfi.h]",
            "ffi_common.h": ":src[include/ffi_common.h]",
            "fficonfig.h": "fficonfig.h",
            "internal64.h": ":src[src/x86/internal64.h]",
            "tramp.h": ":src[include/tramp.h]",
        },
    }),
    preferred_linkage = "static",
)

# The upstream tests read fficonfig.h and ffi_common.h too, and find
# ffitest.h and their .inc files next to themselves, so their compiles take
# the whole source tree.
shims.cxx_library(
    name = "testsuite",
    exported_deps = [":libffi"],
    exported_headers = {
        "ffi_common.h": ":src[include/ffi_common.h]",
        "fficonfig.h": "fficonfig.h",
    },
    exported_preprocessor_flags = [
        "-I$(location :src)/testsuite/libffi.call",
    ],
    header_namespace = "",
)

[
    shims.cxx_binary(
        name = test_name(path) + "-bin",
        srcs = [":src[testsuite/libffi.{}]".format(path)],
        linker_flags = ["-pthread"],
        deps = [":testsuite"],
        **TEST_COMPATIBILITY.get(path, {})
    )
    for path in TESTS
]

[
    shims.command_test(
        name = test_name(path),
        cmd = ["$(exe :{}-bin)".format(test_name(path))],
        **TEST_COMPATIBILITY.get(path, {})
    )
    for path in TESTS
]

shims.cxx_binary(
    name = "test-smoke-bin",
    srcs = ["test.c"],
    deps = [":libffi"],
)

shims.command_test(
    name = "test-smoke",
    cmd = ["$(exe :test-smoke-bin)"],
)
