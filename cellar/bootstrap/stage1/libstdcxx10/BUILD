# SPDX-FileCopyrightText: 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@cellar//bootstrap:source.bzl", "write_file")
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
            "compat",
        ],
        "supc++": ["libsupc++"],
        "stdc++fs": ["filesystem"],
    },
    binutils = "cellar//bootstrap/stage1/binutils",
    config_on = CONFIG_ON,
    config_values = CONFIG_VALUES,
    gcc = "cellar//bootstrap/stage1/gcc10",
    header_files = HEADER_FILES,
    library_objects = LIBRARY_OBJECTS,
    tree = {"gstdint.h": ":gstdint.h"},
    version = "10.5.0",
)

# src/c++11/compatibility-atomic-c++0x.cc includes the gstdint.h configure
# writes.
write_file(
    name = "gstdint.h",
    content = "#include <stdint.h>\n",
)
