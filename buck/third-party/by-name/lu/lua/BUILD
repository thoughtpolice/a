# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:package.bzl", "pkg")
load("@root//buck/shims:shims.bzl", "shims")

VERSION = pkg.version()

# src/Makefile's CORE_O and LIB_O: liblua.a.
LIBRARY_SOURCES = [
    "lapi.c",
    "lcode.c",
    "lctype.c",
    "ldebug.c",
    "ldo.c",
    "ldump.c",
    "lfunc.c",
    "lgc.c",
    "llex.c",
    "lmem.c",
    "lobject.c",
    "lopcodes.c",
    "lparser.c",
    "lstate.c",
    "lstring.c",
    "ltable.c",
    "ltm.c",
    "lundump.c",
    "lvm.c",
    "lzio.c",
    "lauxlib.c",
    "lbaselib.c",
    "lcorolib.c",
    "ldblib.c",
    "liolib.c",
    "lmathlib.c",
    "loadlib.c",
    "loslib.c",
    "lstrlib.c",
    "ltablib.c",
    "lutf8lib.c",
    "linit.c",
]

# What `make install` installs.
PUBLIC_HEADERS = [
    "lauxlib.h",
    "lua.h",
    "lua.hpp",
    "luaconf.h",
    "lualib.h",
]

PRIVATE_HEADERS = [
    "lapi.h",
    "lcode.h",
    "lctype.h",
    "ldebug.h",
    "ldo.h",
    "lfunc.h",
    "lgc.h",
    "ljumptab.h",
    "llex.h",
    "llimits.h",
    "lmem.h",
    "lobject.h",
    "lopcodes.h",
    "lopnames.h",
    "lparser.h",
    "lprefix.h",
    "lstate.h",
    "lstring.h",
    "ltable.h",
    "ltm.h",
    "lundump.h",
    "lvm.h",
    "lzio.h",
]

shims.http_archive(
    name = "src",
    sha256 = "2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6",
    strip_prefix = "lua-{}".format(VERSION),
    sub_targets = ["src/{}".format(f) for f in LIBRARY_SOURCES + PUBLIC_HEADERS + PRIVATE_HEADERS + ["lua.c"]],
    type = "tar.gz",
    # PUC-Rio's own copy of www.lua.org/ftp, byte for byte. http_archive takes
    # only one URL, and lua.org itself times out from GitHub's x86_64 Windows
    # runners while this mirror, on another network, does not.
    urls = [
        "https://www.tecgraf.puc-rio.br/lua/ftp/lua-{}.tar.gz".format(VERSION),
    ],
)

# src/Makefile's CFLAGS and its `linux-noreadline` and `macosx` platform
# settings (macosx's readline aside). Every user of luaconf.h must see the
# same LUA_COMPAT_5_3, so it is exported.
LUA_PLATFORM_FLAGS = shims.select({
    "config//os:macos": ["-DLUA_USE_MACOSX"],
    "config//os:linux": ["-DLUA_USE_LINUX"],
    "DEFAULT": [],
})

shims.cxx_library(
    name = "liblua",
    srcs = [":src[src/{}]".format(f) for f in LIBRARY_SOURCES],
    exported_headers = {
        h: ":src[src/{}]".format(h)
        for h in PUBLIC_HEADERS
    },
    exported_linker_flags = shims.select({
        "config//os:linux": [
            "-ldl",
            "-lm",
        ],
        "DEFAULT": ["-lm"],
    }),
    exported_preprocessor_flags = ["-DLUA_COMPAT_5_3"],
    header_namespace = "",
    headers = {
        h: ":src[src/{}]".format(h)
        for h in PRIVATE_HEADERS
    },
    preferred_linkage = "static",
    preprocessor_flags = LUA_PLATFORM_FLAGS,
)

# The interpreter exports its symbols (the Makefile's -Wl,-E) so that C
# modules it loads can resolve the Lua API from it.
shims.cxx_binary(
    name = "lua",
    srcs = [":src[src/lua.c]"],
    linker_flags = shims.select({
        "config//os:linux": ["-Wl,-E"],
        "DEFAULT": [],
    }),
    preprocessor_flags = LUA_PLATFORM_FLAGS,
    deps = [":liblua"],
)

shims.command_test(
    name = "test-interpreter",
    script = """
        lua=$(exe :lua)
        $lua -v | grep -q "^Lua {version} "
        test "`$lua -e 'print(string.format("%d %s", 6 * 7, ("x"):rep(3)))'`" = "42 xxx"
        test "`$lua -e 'local t = {{}} for i = 1, 100 do t[#t + 1] = i end print(#t .. " " .. utf8.char(955) .. " " .. math.type(1 // 1))'`" = "100 λ integer"
        test "`$lua -e 'print(select(2, pcall(error, "boom", 0)))'`" = "boom"
    """.format(version = VERSION),
)
