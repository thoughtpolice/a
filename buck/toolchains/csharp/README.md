# C# toolchain

Builds C# with the .NET SDK's Roslyn compiler, driven directly: no MSBuild
project files, no NuGet restore. The SDK and the compiler packages are
downloaded from builds.dotnet.microsoft.com and nuget.org at pinned versions
and hashes (see `BUILD`), so a build needs nothing installed.

## Rules

All of them are reachable as `depot.csharp.*` from `@root//buck/shims:shims.bzl`.

| Rule | Produces |
| --- | --- |
| `library(name, srcs, deps, ...)` | one IL assembly, `<name>.dll` (`[pdb]` subtarget) |
| `binary(name, srcs, deps, profile, ...)` | a runnable program, packaged per the profile below |
| `test(...)` | a `binary` whose exit status is the test verdict; takes `args` and `env` |
| `prebuilt_library(name, assembly, pdb, deps)` | an assembly that already exists |
| `nuget_archive(name, package, version, sha256, sub_targets)` | one pinned `.nupkg` from nuget.org, its files addressable as `:name[path]` |
| `reference_assembly(name, assembly)` | a copy of one assembly from the SDK's targeting pack |

Compilation attributes follow the csproj properties they replace:
`nullable` (default `enable`), `implicit_usings` (default on), `unsafe`,
`warnings_as_errors`, `nowarn`, `defines`, `lang_version`, `main`,
`resources` (logical name to file), `analyzers` and `csc_flags`.
`assembly_name` overrides the target name as the assembly's simple name.

`mode//:build-mode` decides `/optimize`, the `DEBUG` symbol, ilc's `-O` and
whether the native executable is stripped. Every build emits a portable PDB.

## Profiles

A `binary` is packaged according to `toolchains//cfg/csharp:profile`, chosen
per build with a modifier (`buck2 build -m aot ...`) or pinned per target
with `profile = "..."`. Libraries are IL under every profile, so switching
only repackages binaries.

| Profile | Output | Runs as |
| --- | --- | --- |
| `jit` (default) | `<name>/` with the assemblies, `runtimeconfig.json` and an apphost | `dotnet exec <name>.dll`; tiered compilation, dynamic PGO off |
| `pgojit` | same layout | the same with dynamic PGO on (`System.Runtime.TieredPGO`) |
| `r2r` | same layout, assemblies precompiled by crossgen2 | `dotnet exec`; ReadyToRun code at startup, hot code re-jitted |
| `aot` | one native executable (`[object]`, `[exports]`, `[dbg]` subtargets) | directly; no runtime needed |

`buck2 run` uses the toolchain's own `dotnet` host for the managed profiles,
so the program finds its runtime wherever the checkout lives. The apphost in
the output directory works too once `DOTNET_ROOT` points at an SDK.

Binary attributes: `invariant_globalization` (default on: culture data
would need ICU on the machine running the program), `server_gc`,
`optimization_preference` (`speed` or `size`), `runtime_options` (extra
`configProperties`), `stack_trace_support`, `trimmer_single_warn`,
`r2r_dependencies` (precompile dependencies too, default on),
`aot_assembly_overrides` (assemblies handed to ILCompiler in place of a
dependency, for AOT-specific repairs), `ilc_flags`, `link_flags`,
`crossgen2_flags`.

The AOT link uses the C++ toolchain's compiler driver and `lld`; the flag
set is the one `Microsoft.NETCore.Native.Unix.targets` emits for a
self-contained, trimmed, PIE executable.

The SDK and the compiler packages are exec-platform dependencies, fetched
once per machine. The NativeAOT runtime pack belongs to the target platform,
so it is fetched once per target configuration (each build mode and profile
combination), about 28 MB each.

## What is not here

- NuGet dependency resolution inside the build. `buck/tools/nugetify`
  resolves `third-party//csharp/nuget.toml` ahead of time into a lock and a
  generated BUILD of `nuget.package` macros over `nuget_archive` and
  `prebuilt_library`.
- Source generators and the SDK's analyzers, unless listed in `analyzers`.
- Windows NativeAOT (needs `link.exe`), and cross-compilation of the managed
  layouts: `r2r` references the exec platform's shared runtime, and the
  apphost is the exec platform's.
- Self-contained managed publishing; the managed profiles are
  framework-dependent on the toolchain's runtime.

## Tools

- `buck2 run toolchains//csharp:dotnet -- --info` runs the pinned SDK's host.
- `tool.py` composes every compiler and linker invocation; its subcommands
  are documented at the top of the file.
- `tests/` builds one program under every profile and checks the result.
