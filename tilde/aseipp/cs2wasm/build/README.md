# Roslyn Native AOT compatibility

`dotnet publish` uses the defaults in `Directory.Build.props`. The project at
the repository root imports `RoslynAot.targets` for the remaining compatibility
fixes in `Microsoft.CodeAnalysis.Common` 5.9.0. Warnings are treated as errors;
trim and AOT analysis remain enabled.

The published Roslyn package and the Roslyn copy in SDK 11 RC1 both omit the
following trimming contracts. `PrepareRoslynAot.cs` adds
`DynamicallyAccessedMembers(PublicParameterlessConstructor)` to:

- `T` on the two `RoslynLazyInitializer.EnsureInitialized` overloads that do
  not accept a factory. Those overloads call `LazyInitializer` overloads that
  construct `T` reflectively. The annotation makes the AOT compiler preserve
  constructors and check the requirement at call sites.
- `TValue` on `PooledDelegates.GetPooledCreateValueCallback` and its nested
  `CreateValueCallbackWithBoundArgument` type. These pass the type argument to
  `ConditionalWeakTable<TKey, TValue>.CreateValueCallback`, which requires the
  same annotation. Factory-taking lazy initializers are left unchanged.

Roslyn also calls `Assembly.Location` when parsing `#error version`. That
property is always empty in Native AOT, and Roslyn already converts the empty
string to `<unknown>`. The AOT input copy returns that fallback directly. The
native integration suite exercises this diagnostic and checks its output.

The task checks the exact upstream informational version and expected members
before changing anything. It writes a deterministic private assembly copy
under `obj/.../native/roslyn`, preserving assembly identity but clearing the
original strong-name signature flag. Only `IlcReference` uses this copy; the
NuGet cache, normal managed build references, and package signatures remain
untouched. Mono.Cecil is a private build dependency and is not included in the
published compiler.

Upstream package source, pinned to commit
`35d9211b841e7613c1d2f8f5af6d628ace696c4c`:

- [RoslynLazyInitializer](https://github.com/dotnet/roslyn/blob/35d9211b841e7613c1d2f8f5af6d628ace696c4c/src/Compilers/Core/Portable/InternalUtilities/RoslynLazyInitializer.cs)
- [PooledDelegates](https://github.com/dotnet/roslyn/blob/35d9211b841e7613c1d2f8f5af6d628ace696c4c/src/Dependencies/PooledObjects/PooledDelegates.cs)
- [CommonCompiler.GetAssemblyLocation](https://github.com/dotnet/roslyn/blob/35d9211b841e7613c1d2f8f5af6d628ace696c4c/src/Compilers/Core/Portable/CommandLine/CommonCompiler.cs)

When upgrading Roslyn, review whether upstream has supplied these fixes and
remove or update this compatibility step. Do not simply relax the version
check: publish with warnings-as-errors and rerun the isolated native integration
suite, including the `#error version` case.
