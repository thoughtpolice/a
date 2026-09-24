# SPDX-FileCopyrightText: © 2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""The macros buck/tools/nugetify emits into third-party//csharp/BUILD.

Keeping the generated file to these calls means a change in how a NuGet
package is fetched or exposed is a change here, not a regeneration."""

load("@root//buck/shims:shims.bzl", depot = "shims")

def _package(
        name: str,
        version: str,
        sha256: str,
        assets: str,
        assemblies: list[str],
        symbols: list[str] = [],
        source: str | None = None,
        deps: list[str] = [],
        visibility: list[str] = []):
    """One NuGet package: the pinned .nupkg from nuget.org (or the feed at
    `source`, a V3 flat-container base URL) and a library of the assemblies
    under `assets` inside it, named after the package.

    The assembly named like the package is the library's own; the others
    ride along as extra assemblies, so a dependent compiles against every
    one of them, the way a NuGet reference would give it."""
    archive = "{}-{}.nupkg".format(name, version)
    depot.csharp.nuget_archive(
        name = archive,
        package = name,
        version = version,
        sha256 = sha256,
        source = source,
        sub_targets = ["{}/{}.dll".format(assets, assembly) for assembly in assemblies] +
                      ["{}/{}.pdb".format(assets, symbol) for symbol in symbols],
    )

    def dll(assembly):
        return ":{}[{}/{}.dll]".format(archive, assets, assembly)

    def pdb(assembly):
        return ":{}[{}/{}.pdb]".format(archive, assets, assembly) if assembly in symbols else None

    primary = name if name in assemblies else assemblies[0]
    extras = [assembly for assembly in assemblies if assembly != primary]
    depot.csharp.prebuilt_library(
        name = name,
        assembly = dll(primary),
        assembly_name = primary,
        pdb = pdb(primary),
        extra_assemblies = {assembly: dll(assembly) for assembly in extras},
        extra_pdbs = {assembly: pdb(assembly) for assembly in extras if assembly in symbols},
        deps = deps,
        visibility = visibility,
    )

def _check(name: str):
    """Fails when nuget.toml, nuget.lock and the BUILD file that carries
    this call no longer agree, so a hand edit or a stale regeneration
    does not go unnoticed."""
    depot.export_file(
        name = name + ".BUILD",
        src = "BUILD",
    )
    depot.export_file(
        name = name + ".nuget.lock",
        src = "nuget.lock",
    )
    depot.export_file(
        name = name + ".nuget.toml",
        src = "nuget.toml",
    )
    depot.command_test(
        name = name,
        script = "$(exe root//buck/tools/nugetify:nugetify) check -manifest $(location :{n}.nuget.toml) -lock $(location :{n}.nuget.lock) -build $(location :{n}.BUILD)".format(n = name),
    )

nuget = struct(
    package = _package,
    check = _check,
)
