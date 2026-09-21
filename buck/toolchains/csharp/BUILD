# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

load("@root//buck/shims:shims.bzl", "shims")
load(
    ":defs.bzl",
    "csharp_toolchain",
    "dotnet_host",
    "download_dotnet_sdk",
    "download_runtime_packages",
    "target_rid_select",
)

# The SDK pin, matched by tilde//aseipp/cs2wasm's global.json. The runtime
# version is the one bundled with that SDK (BundledNETCoreAppPackageVersion);
# every NuGet package below ships at the runtime's version.
DOTNET_SDK_VERSION = "11.0.100-rc.1.26425.128"

DOTNET_RUNTIME_VERSION = "11.0.0-rc.1.26425.128"

TARGET_FRAMEWORK = "net11.0"

# Official SDK archives, keyed by the runtime identifier they run on.
DOTNET_SDK_ARCHIVES = {
    "linux-arm64": "8562f92101fbc531e416920a61cb6646e911af3c1912d486e6ade7752d647ea3",
    "linux-x64": "c21fa6f6f538e9a6df5ec55e3b62fe000d85dff93569f140e78ecb1219a66341",
    "osx-arm64": "a9fdddab915bac780fc656b095db8a83289fb65f829866722a830ed54c9b75f5",
    "win-x64": "0354c2bea15868c95d14e52b527c192e42f95353e7ccc2691dd37314725be36a",
}

# runtime.<rid>.Microsoft.DotNet.ILCompiler: the ilc executable and its JITs,
# for the machine running the build.
ILCOMPILER_PACKAGES = {
    "linux-arm64": "23ae8869b539a252875856962cb5d401c92c6de57f70503aa67a2e04b3a9cd6c",
    "linux-x64": "67605286ff33c8f0d91a9e93353a26818dbe2efc8acd4dd809fd3c38f77d082f",
    "osx-arm64": "843610391baaeaacd154a99acb3273899cf2a7ca5fa475364ab57ad18e75aaf3",
}

# Microsoft.NETCore.App.Runtime.NativeAOT.<rid>: the framework assemblies and
# static runtime libraries an AOT executable is compiled and linked against,
# for the platform the executable runs on.
NATIVEAOT_RUNTIME_PACKS = {
    "linux-arm64": "552023d984285f82a3c054fbe6384622db9371d973cea8fc550ab937418acd88",
    "linux-x64": "4fa567dfe91859911ba2194975af6a39f9ee646fab9e3e201367f42df29a7491",
    "osx-arm64": "f0821a6e7e27e4e743bbe966bfb27a49d934f50caa0b19a1baf1c86228354034",
}

# Microsoft.NETCore.App.Crossgen2.<rid>: the ReadyToRun compiler, for the
# machine running the build.
CROSSGEN2_PACKAGES = {
    "linux-arm64": "60d7f2f8d5cf72d79c6f64d3a0f2ed91c5c7a63846543741bdbc8535a87d807b",
    "linux-x64": "3e9482617648bc9d236d2e9ffac1d1243585d8cbe3cddddd39ed2cf87929e9c2",
    "osx-arm64": "69e073cf75ed94ed8f4381533826533dba4bd7ad361cdd44ca54db5d3a189e52",
}

download_dotnet_sdk(
    hashes = DOTNET_SDK_ARCHIVES,
    version = DOTNET_SDK_VERSION,
)

# What an exec-platform package select falls back to on a machine without
# one: the profiles that need the package fail with a message, the others
# keep working.
shims.filegroup(
    name = "unavailable",
    srcs = [],
)

ilc = download_runtime_packages(
    executables = ["tools/ilc"],
    hashes = ILCOMPILER_PACKAGES,
    kind = "ilcompiler",
    package = "runtime.{rid}.Microsoft.DotNet.ILCompiler",
    target = False,
    version = DOTNET_RUNTIME_VERSION,
)

crossgen2 = download_runtime_packages(
    executables = ["tools/crossgen2"],
    hashes = CROSSGEN2_PACKAGES,
    kind = "crossgen2",
    package = "Microsoft.NETCore.App.Crossgen2.{rid}",
    target = False,
    version = DOTNET_RUNTIME_VERSION,
)

nativeaot_pack = download_runtime_packages(
    hashes = NATIVEAOT_RUNTIME_PACKS,
    kind = "nativeaot",
    package = "Microsoft.NETCore.App.Runtime.NativeAOT.{rid}",
    target = True,
    version = DOTNET_RUNTIME_VERSION,
)

# Composes every compiler and linker invocation; see tool.py.
shims.python_binary(
    name = "tool",
    main = "tool.py",
    visibility = ["PUBLIC"],
)

csharp_toolchain(
    name = "csharp-{}".format(DOTNET_SDK_VERSION),
    # NativeAOT's Linux link line is written for bfd or lld; lld is the one
    # the C++ toolchain already requires, and it needs the linker script the
    # helper writes for it.
    aot_linker_flavor = shims.select({
        "config//os:linux": "lld",
        "DEFAULT": None,
    }),
    build_mode = shims.select({
        "mode//:build-mode[debug]": "debug",
        "mode//:build-mode[release]": "release",
    }),
    crossgen2 = crossgen2,
    ilc = ilc,
    lang_version = "14.0",
    nativeaot_pack = nativeaot_pack,
    profile = shims.select({
        "toolchains//cfg/csharp:profile[aot]": "aot",
        "toolchains//cfg/csharp:profile[jit]": "jit",
        "toolchains//cfg/csharp:profile[pgojit]": "pgojit",
        "toolchains//cfg/csharp:profile[r2r]": "r2r",
    }),
    rid = target_rid_select(),
    runtime_version = DOTNET_RUNTIME_VERSION,
    sdk = ":sdk-{}".format(DOTNET_SDK_VERSION),
    sdk_version = DOTNET_SDK_VERSION,
    tfm = TARGET_FRAMEWORK,
)

shims.toolchain_alias(
    name = "csharp",
    actual = ":csharp-{}".format(DOTNET_SDK_VERSION),
)

# `buck2 run toolchains//csharp:dotnet -- --info`
dotnet_host(
    name = "dotnet",
    muxer = shims.select({
        "config//os:windows": "dotnet.exe",
        "DEFAULT": "dotnet",
    }),
    sdk = ":sdk-{}".format(DOTNET_SDK_VERSION),
    visibility = ["PUBLIC"],
)
