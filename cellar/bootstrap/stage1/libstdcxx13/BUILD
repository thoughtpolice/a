# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:actions.bzl", "concatenate")
load("@cellar//bootstrap:defs.bzl", "filegroup")
load("@cellar//bootstrap:source.bzl", "write_file")
load("@cellar//bootstrap/stage1/gcc:defs.bzl", "CATM")
load("@cellar//bootstrap/stage1/gcc:libstdcxx.bzl", "libstdcxx_port")
load(":config.bzl", "CONFIG_ON", "CONFIG_VALUES")
load(":sources.bzl", "HEADER_FILES", "LIBRARY_OBJECTS")

libstdcxx_port(
    archives = {
        "stdc++": [
            "libsupc++",
            "c++98",
            "c++11",
            "c++17",
            "c++20",
            "compat",
        ],
        "supc++": ["libsupc++"],
        "stdc++fs": ["filesystem"],
        "stdc++exp": [
            "experimental",
            "filesystem",
        ],
    },
    binutils = "cellar//bootstrap/stage1/binutils241",
    config_on = CONFIG_ON,
    config_values = CONFIG_VALUES,
    cxxconfig_edits = ["s,^#undef _GLIBCXX_VERBOSE_ASSERT$,#define _GLIBCXX_VERBOSE_ASSERT 1,"],
    deleted_config = ["_GLIBCXX_LONG_DOUBLE_ALT128_COMPAT"],
    gcc = "cellar//bootstrap/stage1/gcc13",
    header_files = HEADER_FILES,
    library_objects = LIBRARY_OBJECTS,
    source_files = ["libstdc++-v3/src/c++20/tzdata.zi"],
    # C++20 ranges, std::format, the time zone database, calendar types,
    # jthread, latches, barriers and semaphores.
    tests = {
        "cxx20": struct(
            source = "tests/cxx20.cc",
            standard = "gnu++20",
            threaded = True,
        ),
    },
    tree = {"build/tzdata.zi.h": ":tzdata.zi.h"},
    version = "13.5.0",
)

# tzdb.cc embeds the release's time zone data, as src/c++20/Makefile.am
# wraps it in a raw string literal. With static data only, no zoneinfo
# directory is searched unless a program installs an override.
write_file(
    name = "tzdata-prefix",
    content = 'static const char tzdata_chars[] = R"__libstdcxx__(\n',
)

write_file(
    name = "tzdata-suffix",
    content = ')__libstdcxx__";\n',
)

concatenate(
    name = "tzdata.zi.h",
    inputs = [
        ":tzdata-prefix",
        ":gcc-13.5.0[libstdc++-v3/src/c++20/tzdata.zi]",
        ":tzdata-suffix",
    ],
    output = "tzdata.zi.h",
    tool = CATM,
)

# The final stage's headers, archives and notices, as the installation lays
# them out.
filegroup(
    name = "stage3-installation",
    srcs = {
        "include/c++/13.5.0": ":headers",
        "lib/libstdc++.a": ":stage3-libstdc++.a",
        "lib/libsupc++.a": ":stage3-libsupc++.a",
        "lib/libstdc++fs.a": ":stage3-libstdc++fs.a",
        "lib/libstdc++exp.a": ":stage3-libstdc++exp.a",
        "share/licenses/libstdc++/COPYING3": ":gcc-13.5.0[COPYING3]",
        "share/licenses/libstdc++/COPYING.RUNTIME": ":gcc-13.5.0[COPYING.RUNTIME]",
    },
)
