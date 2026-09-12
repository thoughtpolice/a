// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Gameplay.Compiler;

// Roslyn source generators (`--generator PATH`), run over the sources'
// compilation before it is emitted, as csc runs the generators of its
// /analyzer: references: the same discovery (an assembly's
// [Generator]-attributed ISourceGenerator and IIncrementalGenerator types,
// through AnalyzerFileReference), the same driver, and the generated trees
// compiled with the sources. A generator's diagnostics are the
// compilation's: an error fails it with the compiler's own, a warning is
// reported and the compilation goes on. A generator that throws fails the
// compilation (csc makes that warning CS8785 and goes on without the
// generator's output, which here would only fail later and less clearly).
//
// What a generator knows of the build beyond the compilation, it reads as
// MSBuild gives generators a project's CompilerVisibleProperty items: as
// global analyzer config options named `build_property.<Name>`
// (AnalyzerConfigOptionsProvider.GlobalOptions). gameplayc gives them
// GameplayOutputKind, `library` for `--library` and `module` otherwise
// (both are compiled as a DLL, so OutputKind cannot tell them apart), and
// GameplayAssemblyName, the assembly's name.
//
// Generator assemblies are loaded into the compiler's process, so they are
// compiled against the Microsoft.CodeAnalysis the compiler embeds (the
// toolchain's third-party//csharp:Microsoft.CodeAnalysis.CSharp), which
// their references resolve to.
internal static class Generators
{
    public static ImmutableArray<ISourceGenerator> Load(IReadOnlyList<string> paths)
    {
        if (paths.Count == 0)
        {
            return [];
        }

        var loader = new Loader();
        var generators = ImmutableArray.CreateBuilder<ISourceGenerator>();
        foreach (string path in paths)
        {
            string fullPath = Path.GetFullPath(path);
            if (!File.Exists(fullPath))
            {
                throw new CompileError($"Generator assembly '{path}' does not exist.");
            }

            loader.AddDependencyLocation(fullPath);
            var reference = new AnalyzerFileReference(fullPath, loader);
            var failures = new List<string>();
            reference.AnalyzerLoadFailed += (_, failure) => failures.Add(
                failure.TypeName is { } type ? $"{type}: {failure.Message}" : failure.Message);
            var found = reference.GetGenerators(LanguageNames.CSharp);
            if (failures.Count != 0)
            {
                throw new CompileError($"Generator assembly '{path}' did not load: {string.Join("; ", failures)}");
            }

            if (found.IsEmpty)
            {
                throw new CompileError($"Generator assembly '{path}' declares no C# source generator.");
            }

            generators.AddRange(found);
        }

        return generators.ToImmutable();
    }

    // The build properties a compilation's generators see.
    public static ImmutableDictionary<string, string> BuildProperties(bool library, string assemblyName) =>
        ImmutableDictionary.CreateRange(StringComparer.Ordinal, new[]
        {
            KeyValuePair.Create("build_property.GameplayOutputKind", library ? "library" : "module"),
            KeyValuePair.Create("build_property.GameplayAssemblyName", assemblyName),
        });

    // The sources' compilation with every generator's output added, or a
    // CompileError with the generators' errors.
    public static CSharpCompilation Run(
        CSharpCompilation compilation,
        ImmutableArray<ISourceGenerator> generators,
        CSharpParseOptions parseOptions,
        ImmutableDictionary<string, string> buildProperties)
    {
        if (generators.IsEmpty)
        {
            return compilation;
        }

        GeneratorDriver driver = CSharpGeneratorDriver.Create(
            generators, parseOptions: parseOptions, optionsProvider: new BuildOptions(buildProperties));
        driver = driver.RunGeneratorsAndUpdateCompilation(compilation, out var updated, out var diagnostics);
        var result = driver.GetRunResult();
        var failures = result.Results
            .Where(run => run.Exception is not null)
            .Select(run => $"error GAMEPLAYC0001: Generator '{run.Generator.GetGeneratorType().FullName}' threw {run.Exception!.GetType().Name}: {run.Exception.Message}")
            .ToList();
        var errors = diagnostics
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .Select(diagnostic => diagnostic.ToString())
            .ToList();
        // For the compiler's and a generator's own debugging: what each
        // generator wrote, as files named by their hints.
        if (Environment.GetEnvironmentVariable("GAMEPLAYC_DUMP_GENERATED") is { Length: > 0 } dump)
        {
            foreach (var run in result.Results)
            {
                string directory = Path.Combine(dump, run.Generator.GetGeneratorType().FullName ?? "generator");
                Directory.CreateDirectory(directory);
                foreach (var source in run.GeneratedSources)
                {
                    File.WriteAllText(Path.Combine(directory, source.HintName), source.SourceText.ToString());
                }
            }
        }

        foreach (var warning in diagnostics.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Warning))
        {
            Console.Error.WriteLine(warning.ToString());
        }

        if (failures.Count + errors.Count != 0)
        {
            throw new CompileError(string.Join(Environment.NewLine, failures.Concat(errors).Take(32)));
        }

        return (CSharpCompilation)updated;
    }

    // The build's properties as the global options every tree and
    // additional file sees (gameplayc has no .editorconfig of its own).
    private sealed class BuildOptions(ImmutableDictionary<string, string> properties) : AnalyzerConfigOptionsProvider
    {
        private readonly Options options = new(properties);

        public override AnalyzerConfigOptions GlobalOptions => options;

        public override AnalyzerConfigOptions GetOptions(SyntaxTree tree) => options;

        public override AnalyzerConfigOptions GetOptions(AdditionalText textFile) => options;

        private sealed class Options(ImmutableDictionary<string, string> properties) : AnalyzerConfigOptions
        {
            public override bool TryGetValue(string key, [NotNullWhen(true)] out string? value) =>
                properties.TryGetValue(key, out value);

            public override IEnumerable<string> Keys => properties.Keys;
        }
    }

    // Loads generator assemblies into the compiler's own load context,
    // where their references to Microsoft.CodeAnalysis resolve to the
    // compiler's; an assembly beside one of them resolves from there.
    private sealed class Loader : IAnalyzerAssemblyLoader
    {
        private readonly List<string> directories = [];

        public Loader()
        {
            AssemblyLoadContext.Default.Resolving += Resolve;
        }

        public void AddDependencyLocation(string fullPath)
        {
            string? directory = Path.GetDirectoryName(fullPath);
            if (directory is not null && !directories.Contains(directory, StringComparer.Ordinal))
            {
                directories.Add(directory);
            }
        }

        public Assembly LoadFromPath(string fullPath) =>
            AssemblyLoadContext.Default.LoadFromAssemblyPath(fullPath);

        private Assembly? Resolve(AssemblyLoadContext context, AssemblyName name)
        {
            foreach (string directory in directories)
            {
                string candidate = Path.Combine(directory, name.Name + ".dll");
                if (File.Exists(candidate))
                {
                    return context.LoadFromAssemblyPath(candidate);
                }
            }

            return null;
        }
    }
}
